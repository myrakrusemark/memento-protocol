/**
 * HostedStorageAdapter -- HTTP client that implements StorageInterface
 * by calling the Memento SaaS API instead of reading flat files.
 *
 * The SaaS API returns MCP-format responses:
 *   { content: [{ type: "text", text: "..." }] }
 *
 * For methods where the API's text response is the final output (store,
 * recall, update, skip_add, skip_check, health), we return { _raw: true }
 * so index.js can pass the text through without re-formatting.
 *
 * For initWorkspace and readWorkingMemory, we return structured objects
 * matching the LocalStorageAdapter contract so index.js can handle them
 * identically.
 */

import { StorageInterface } from "./interface.js";

export class HostedStorageAdapter extends StorageInterface {
  constructor({ apiKey, apiUrl, workspace }) {
    super();
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/$/, ""); // strip trailing slash
    this.workspace = workspace || "default";
  }

  /**
   * Make an authenticated API call to the SaaS backend.
   * Extracts the text from the MCP-format response envelope.
   */
  async _fetch(method, path, body) {
    const url = `${this.apiUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Memento-Workspace": this.workspace,
      "Content-Type": "application/json",
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const json = await res.json();
    const text = json.content?.[0]?.text || "";

    return { text, status: res.status, isError: res.status >= 400 };
  }

  /**
   * Make an authenticated API call that returns raw JSON (not MCP envelope).
   * Used for new structured endpoints (items, context, memories list).
   */
  async _fetchJson(method, path, body) {
    const url = `${this.apiUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Memento-Workspace": this.workspace,
      "Content-Type": "application/json",
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const json = await res.json();

    if (res.status >= 400) {
      return { error: json.error || JSON.stringify(json) };
    }

    return json;
  }

  async initWorkspace(_wsPath) {
    const { text, isError } = await this._fetch("POST", "/v1/workspaces", {
      name: this.workspace,
    });
    if (text.includes("already exists")) {
      return { alreadyExists: true };
    }
    if (isError) return { error: text };
    return { created: true };
  }

  async readWorkingMemory(_wsPath, section) {
    const path = section
      ? `/v1/working-memory/${section}`
      : "/v1/working-memory";
    const { text, isError } = await this._fetch("GET", path);
    if (isError) return { error: text };
    return { content: text };
  }

  async updateWorkingMemory(_wsPath, section, content) {
    const { text, isError } = await this._fetch(
      "PUT",
      `/v1/working-memory/${section}`,
      { content }
    );
    if (isError) return { error: text };
    return { _raw: true, text, isError: false };
  }

  async storeMemory(_wsPath, { content, tags, type, expires }) {
    const { text, isError } = await this._fetch("POST", "/v1/memories", {
      content,
      tags,
      type,
      expires,
    });
    if (isError) return { error: text };
    return { _raw: true, text, isError: false };
  }

  async recallMemories(_wsPath, { query, tags, type, limit }) {
    const params = new URLSearchParams({ query });
    if (tags?.length) params.set("tags", tags.join(","));
    if (type) params.set("type", type);
    if (limit) params.set("limit", String(limit));

    const { text, isError } = await this._fetch(
      "GET",
      `/v1/memories/recall?${params}`
    );
    if (isError) return { error: text };
    return { _raw: true, text, isError: false };
  }

  async addSkip(_wsPath, { item, reason, expires }) {
    const { text, isError } = await this._fetch("POST", "/v1/skip-list", {
      item,
      reason,
      expires,
    });
    if (isError) return { error: text };
    return { _raw: true, text, isError: false };
  }

  async checkSkip(_wsPath, query) {
    const params = new URLSearchParams({ query });
    const { text, isError } = await this._fetch(
      "GET",
      `/v1/skip-list/check?${params}`
    );
    if (isError) return { error: text };
    return { _raw: true, text, isError: false };
  }

  async getHealth(_wsPath) {
    const { text, isError } = await this._fetch("GET", "/v1/health");
    if (isError) return { error: text };
    return { _raw: true, text, isError: false };
  }

  async createItem(_wsPath, data) {
    const res = await this._fetchJson("POST", "/v1/working-memory/items", data);
    if (res.error) return { error: res.error };
    return res;
  }

  async updateItem(_wsPath, id, data) {
    const res = await this._fetchJson("PUT", `/v1/working-memory/items/${id}`, data);
    if (res.error) return { error: res.error };
    return res;
  }

  async deleteItem(_wsPath, id) {
    const res = await this._fetchJson("DELETE", `/v1/working-memory/items/${id}`);
    if (res.error) return { error: res.error };
    return res;
  }

  async listItems(_wsPath, filters = {}) {
    const params = new URLSearchParams();
    if (filters.category) params.set("category", filters.category);
    if (filters.status) params.set("status", filters.status);
    if (filters.query) params.set("q", filters.query);
    const qs = params.toString();
    const path = `/v1/working-memory/items${qs ? `?${qs}` : ""}`;
    const res = await this._fetchJson("GET", path);
    if (res.error) return { error: res.error };
    return res;
  }

  async getContext(_wsPath, message) {
    const res = await this._fetchJson("POST", "/v1/context", { message });
    if (res.error) return { error: res.error };
    return res;
  }
}
