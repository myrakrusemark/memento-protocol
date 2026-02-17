/* eslint-disable no-unused-vars */

/**
 * StorageInterface -- Base class defining the storage contract for Memento.
 *
 * Every method receives `wsPath` (the resolved workspace path) as its first
 * argument. Implementations handle all persistence details.
 *
 * Methods return plain objects -- the MCP response formatting stays in index.js.
 */
export class StorageInterface {
  /**
   * Initialize a workspace. Creates directory structure and template files.
   * @param {string} wsPath - Resolved workspace path
   * @returns {Promise<{ alreadyExists?: boolean, created?: boolean, error?: string }>}
   */
  async initWorkspace(wsPath) {
    throw new Error("Not implemented");
  }

  /**
   * Read working memory -- full document or a specific section.
   * @param {string} wsPath - Resolved workspace path
   * @param {string} [section] - Optional section shorthand key or heading name
   * @returns {Promise<{ content?: string, error?: string }>}
   */
  async readWorkingMemory(wsPath, section) {
    throw new Error("Not implemented");
  }

  /**
   * Update a section of working memory.
   * @param {string} wsPath - Resolved workspace path
   * @param {string} section - Section shorthand key or heading name
   * @param {string} content - New content for the section
   * @returns {Promise<{ heading?: string, error?: string }>}
   */
  async updateWorkingMemory(wsPath, section, content) {
    throw new Error("Not implemented");
  }

  /**
   * Store a discrete memory with metadata.
   * @param {string} wsPath - Resolved workspace path
   * @param {{ content: string, tags?: string[], type?: string, expires?: string }} params
   * @returns {Promise<{ id?: string, type?: string, tags?: string[], error?: string }>}
   */
  async storeMemory(wsPath, { content, tags, type, expires }) {
    throw new Error("Not implemented");
  }

  /**
   * Search stored memories by keyword, tag, or type.
   * @param {string} wsPath - Resolved workspace path
   * @param {{ query: string, tags?: string[], type?: string, limit?: number }} params
   * @returns {Promise<{ results?: Array, formatted?: string, error?: string }>}
   */
  async recallMemories(wsPath, { query, tags, type, limit }) {
    throw new Error("Not implemented");
  }

  /**
   * Add an item to the skip list.
   * @param {string} wsPath - Resolved workspace path
   * @param {{ item: string, reason: string, expires: string }} params
   * @returns {Promise<{ item?: string, expires?: string, error?: string }>}
   */
  async addSkip(wsPath, { item, reason, expires }) {
    throw new Error("Not implemented");
  }

  /**
   * Check if something should be skipped. Auto-clears expired entries.
   * @param {string} wsPath - Resolved workspace path
   * @param {string} query - What to check against the skip list
   * @returns {Promise<{ match?: object, error?: string }>}
   */
  async checkSkip(wsPath, query) {
    throw new Error("Not implemented");
  }

  /**
   * Report memory system health and stats.
   * @param {string} wsPath - Resolved workspace path
   * @returns {Promise<{ stats?: object, formatted?: string, error?: string }>}
   */
  async getHealth(wsPath) {
    throw new Error("Not implemented");
  }

  /**
   * Create a working memory item.
   * @param {string} wsPath - Resolved workspace path
   * @param {{ category: string, title: string, content?: string, status?: string, priority?: number, tags?: string[], next_action?: string }} data
   * @returns {Promise<object>}
   */
  async createItem(wsPath, data) {
    throw new Error("Not implemented");
  }

  /**
   * Update a working memory item (partial).
   * @param {string} wsPath - Resolved workspace path
   * @param {string} id - Item ID
   * @param {object} data - Fields to update
   * @returns {Promise<object>}
   */
  async updateItem(wsPath, id, data) {
    throw new Error("Not implemented");
  }

  /**
   * Delete a working memory item.
   * @param {string} wsPath - Resolved workspace path
   * @param {string} id - Item ID
   * @returns {Promise<{ deleted?: boolean, error?: string }>}
   */
  async deleteItem(wsPath, id) {
    throw new Error("Not implemented");
  }

  /**
   * List working memory items with optional filters.
   * @param {string} wsPath - Resolved workspace path
   * @param {{ category?: string, status?: string, query?: string }} filters
   * @returns {Promise<{ items?: object[], total?: number, error?: string }>}
   */
  async listItems(wsPath, filters) {
    throw new Error("Not implemented");
  }

  /**
   * Consolidate multiple memories into a single richer memory.
   * @param {string} wsPath - Resolved workspace path
   * @param {{ source_ids: string[], content?: string, type?: string, tags?: string[] }} params
   * @returns {Promise<{ _raw?: boolean, text?: string, error?: string }>}
   */
  async consolidateMemories(wsPath, { source_ids, content, type, tags }) {
    throw new Error("Not implemented");
  }

  /**
   * Get context — everything relevant for a message in one call.
   * @param {string} wsPath - Resolved workspace path
   * @param {string} message - The user's message
   * @returns {Promise<object>}
   */
  async getContext(wsPath, message) {
    throw new Error("Not implemented");
  }
}
