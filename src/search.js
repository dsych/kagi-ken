/**
 * @fileoverview Kagi search functionality
 */

import * as cheerio from "cheerio";
import { USER_AGENT } from "./utils/http.js";

/**
 * Parses SSE stream data into tagged messages
 * Waits for the full stream to complete (terminated by `id: CLOSE`) before parsing.
 *
 * @param {string} text - Raw SSE stream text (entire response)
 * @returns {Array<{tag: string, payload: string|object}>} Array of parsed messages
 */
function parseSseStream(text) {
  const messages = [];

  // Split the stream into frames by `\nid:` delimiter
  // The stream format is: `\nid: N\ndata: [JSON]\n\nid: M\ndata: [JSON]\n\nid: CLOSE\ndata:`
  const frames = text.split('\nid:');

  for (const frame of frames) {
    const trimmed = frame.trim();
    if (!trimmed) continue;

    // Check for CLOSE marker - stream termination
    if (trimmed.startsWith('CLOSE')) {
      break; // End of stream, stop processing
    }

    // Extract the `data:` line from the frame
    // Frame format: `N\ndata: [JSON]\n\n`
    // Note: JSON payload may span multiple lines (e.g., HTML in search results)
    const dataMatch = trimmed.match(/^\d*\s*data:\s*(.+)$/s);
    if (dataMatch) {
      const dataLine = dataMatch[1].trim();
      if (!dataLine) continue; // Empty data line (e.g., after CLOSE)

      try {
        const parsed = JSON.parse(dataLine);
        if (Array.isArray(parsed)) {
          for (const msg of parsed) {
            if (msg && msg.tag && msg.payload !== undefined) {
              messages.push({ tag: msg.tag, payload: msg.payload });
            }
          }
        }
      } catch {
        // Ignore parse errors for this frame
      }
    }
  }

  return messages;
}

/**
 * Performs a search via Kagi's SSE streaming endpoint
 *
 * @param {string} query - Search query
 * @param {string} token - Kagi session token
 * @param {Object} [options] - Search options
 * @param {number} [options.limit=10] - Maximum number of search results to return
 * @param {number} [options.page=1] - Pagination page number
 * @param {number} [options.timeout=30000] - Timeout in milliseconds
 * @returns {Promise<Object>} Object containing data array with search results and related searches
 */
export async function sseSearch(query, token, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('Search query is required and must be a string');
  }

  if (!token || typeof token !== 'string') {
    throw new Error('Session token is required and must be a string');
  }

  const limit = options.limit ?? 10;
  const page = options.page ?? 1;
  const timeout = options.timeout ?? 30000;

  if (
    limit !== undefined &&
    (typeof limit !== 'number' || limit < 1 || !Number.isInteger(limit))
  ) {
    throw new Error('Limit must be a positive integer');
  }

  if (page < 1 || !Number.isInteger(page)) {
    throw new Error('Page must be a positive integer');
  }

  try {
    const searchParams = new URLSearchParams();
    searchParams.set('q', query);
    if (page > 1) {
      searchParams.set('page', String(page));
    }

    const url = `https://kagi.com/socket/search?${searchParams.toString()}`;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/event-stream',
        'Cookie': `kagi_session=${token}`,
        'Referer': `https://kagi.com/search?q=${encodeURIComponent(query)}`,
      },
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid or expired session token');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const messages = parseSseStream(text);

    // Check for auth redirect (invalid/expired token)
    const bangMsg = messages.find(m => m.tag === 'bang');
    if (bangMsg && bangMsg.payload === '/signin') {
      throw new Error('Invalid or expired session token');
    }

    // Extract search results HTML
    const searchMsg = messages.find(m => m.tag === 'search');
    const relatedMsg = messages.find(m => m.tag === 'related_searches');

    const results = [];
    let resultCount = 0;

    // Parse organic search results from SSE payload
    // Note: search payload is { content: "<html>..." } not a plain string
    if (searchMsg && searchMsg.payload) {
      try {
        const searchHtml = typeof searchMsg.payload === 'string'
          ? searchMsg.payload
          : (searchMsg.payload.content || '');
        const $ = cheerio.load(searchHtml);
        $('.search-result').each((_, element) => {
          if (resultCount >= limit) return false;
          const result = extractSearchResult($, element);
          if (result) {
            results.push(result);
            resultCount++;
          }
        });
      } catch {
        // Ignore parsing errors
      }
    }

    // Parse related searches from SSE payload
    if (relatedMsg && relatedMsg.payload) {
      try {
        const $ = cheerio.load(relatedMsg.payload);
        const relatedSearches = extractRelatedSearches($);
        if (relatedSearches.length > 0) {
          results.push({
            t: 1,
            list: relatedSearches,
          });
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return { data: results };
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Network error: Unable to connect to Kagi');
    }
    if (error.name === 'AbortError') {
      throw new Error('Search request timed out');
    }
    throw error;
  }
}

/**
 * Performs a search on Kagi.com and returns structured results
 *
 * @param {string} query - Search query
 * @param {string} token - Kagi session token
 * @param {number} [limit=10] - Maximum number of search results to return (default: 10)
 * @returns {Promise<Object>} Object containing data array with search results and related searches
 */
export async function search(query, token, limit = 10) {
  if (!query || typeof query !== "string") {
    throw new Error("Search query is required and must be a string");
  }

  if (!token || typeof token !== "string") {
    throw new Error("Session token is required and must be a string");
  }

  if (
    limit !== undefined &&
    (typeof limit !== "number" || limit < 1 || !Number.isInteger(limit))
  ) {
    throw new Error("Limit must be a positive integer");
  }

  try {
    const response = await fetch(
      `https://kagi.com/html/search?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Cookie": `kagi_session=${token}`,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Invalid or expired session token");
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const results = parseSearchResults(html, limit);
    return { data: results };
  } catch (error) {
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      throw new Error("Network error: Unable to connect to Kagi");
    }
    throw error;
  }
}

/**
 * Parses HTML content to extract search results
 *
 * @param {string} html - HTML content from Kagi search page
 * @param {number} limit - Maximum number of search results to return
 * @returns {Array} Array of search results and related searches
 */
function parseSearchResults(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  let resultCount = 0;

  try {
    // Extract main search results
    $(".search-result").each((_, element) => {
      if (resultCount >= limit) return false; // Stop if limit reached
      const result = extractSearchResult($, element);
      if (result) {
        results.push(result);
        resultCount++;
      }
    });

    // Extract grouped sub-results
    if (resultCount < limit) {
      $(".sr-group .__srgi").each((_, element) => {
        if (resultCount >= limit) return false; // Stop if limit reached
        const result = extractGroupedResult($, element);
        if (result) {
          results.push(result);
          resultCount++;
        }
      });
    }

    // Extract related searches (always included regardless of limit)
    const relatedSearches = extractRelatedSearches($);
    if (relatedSearches.length > 0) {
      results.push({
        t: 1,
        list: relatedSearches,
      });
    }

    return results;
  } catch (error) {
    throw new Error(
      "Failed to parse search results - unexpected HTML structure",
    );
  }
}

/**
 * Extracts a single search result from a search-result element
 *
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {CheerioElement} element - Search result element
 * @returns {Object|null} Parsed search result or null if invalid
 */
function extractSearchResult($, element) {
  try {
    const $element = $(element);

    // Extract title and URL
    const titleLink = $element.find(".__sri_title_link").first();
    const title = titleLink.text().trim();
    const url = titleLink.attr("href");

    // Extract snippet
    const snippet = $element.find(".__sri-desc").text().trim();

    if (!title || !url) {
      return null;
    }

    return {
      t: 0,
      url: url,
      title: title,
      snippet: snippet || "",
    };
  } catch (error) {
    return null;
  }
}

/**
 * Extracts a grouped search result from a __srgi element
 *
 * @param {CheerioAPI} $ - Cheerio instance
 * @param {CheerioElement} element - Grouped result element
 * @returns {Object|null} Parsed search result or null if invalid
 */
function extractGroupedResult($, element) {
  try {
    const $element = $(element);

    // Extract title and URL
    const titleLink = $element.find(".__srgi-title a").first();
    const title = titleLink.text().trim();
    const url = titleLink.attr("href");

    // Extract snippet
    const snippet = $element.find(".__sri-desc").text().trim();

    if (!title || !url) {
      return null;
    }

    return {
      t: 0,
      url: url,
      title: title,
      snippet: snippet || "",
    };
  } catch (error) {
    return null;
  }
}

/**
 * Extracts related search terms
 *
 * @param {CheerioAPI} $ - Cheerio instance
 * @returns {Array<string>} Array of related search terms
 */
function extractRelatedSearches($) {
  const relatedSearches = [];

  try {
    $(".related-searches a span").each((_, element) => {
      const term = $(element).text().trim();
      if (term) {
        relatedSearches.push(term);
      }
    });
  } catch (error) {
    // Return empty array if parsing fails
  }

  return relatedSearches;
}
