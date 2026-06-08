/**
 * Watch list + searchable virtualized picker (add from search, remove from list).
 */
class WatchListPicker {
    constructor(root, {
        placeholder = 'Search to add…',
        emptyText = 'No results',
        watchingEmpty = 'Nobody on the watch list yet — search below to add.',
        rowHeight = 36,
        viewportHeight = 200,
        selected = [],
        loadItems,
        onChange,
    } = {}) {
        this.root = root;
        this.placeholder = placeholder;
        this.emptyText = emptyText;
        this.watchingEmpty = watchingEmpty;
        this.rowHeight = rowHeight;
        this.viewportHeight = viewportHeight;
        this.loadItems = loadItems;
        this.onChange = onChange;
        this.watching = new Map();
        for (const item of selected) {
            if (item?.id != null) this.watching.set(String(item.id), item);
        }
        this.items = [];
        this.search = '';
        this.loading = false;
        this.hasMore = false;
        this.page = 0;
        this.scrollTop = 0;
        this.searchTimer = null;
        this._render = this._render.bind(this);
        this._onScroll = this._onScroll.bind(this);
        this._build();
        this.reload();
    }

    getSelected() {
        return [...this.watching.values()];
    }

    getSelectedIds() {
        return this.getSelected().map((i) => i.id);
    }

    setSelected(items) {
        this.watching = new Map();
        for (const item of items || []) {
            if (item?.id != null) this.watching.set(String(item.id), item);
        }
        this._renderWatching();
        this._render();
        this.onChange?.(this.getSelected());
    }

    add(item) {
        if (!item?.id) return;
        this.watching.set(String(item.id), item);
        this._renderWatching();
        this._render();
        this.onChange?.(this.getSelected());
    }

    remove(id) {
        this.watching.delete(String(id));
        this._renderWatching();
        this._render();
        this.onChange?.(this.getSelected());
    }

    async reload() {
        this.page = 0;
        this.items = [];
        this.hasMore = false;
        await this._fetch(true);
    }

    _build() {
        this.root.classList.add('wlp-root');
        this.root.innerHTML = `
            <div class="wlp-watching-wrap">
                <div class="wlp-watching-label">Watching <span class="wlp-count"></span></div>
                <div class="wlp-watching-list"></div>
                <p class="wlp-watching-empty"></p>
            </div>
            <input type="text" class="wlp-search" autocomplete="off" />
            <div class="wlp-viewport">
                <div class="wlp-spacer"></div>
                <div class="wlp-rows"></div>
            </div>
            <div class="wlp-status"></div>
        `;
        this.watchingListEl = this.root.querySelector('.wlp-watching-list');
        this.watchingEmptyEl = this.root.querySelector('.wlp-watching-empty');
        this.countEl = this.root.querySelector('.wlp-count');
        this.searchEl = this.root.querySelector('.wlp-search');
        this.viewportEl = this.root.querySelector('.wlp-viewport');
        this.spacerEl = this.root.querySelector('.wlp-spacer');
        this.rowsEl = this.root.querySelector('.wlp-rows');
        this.statusEl = this.root.querySelector('.wlp-status');
        this.searchEl.placeholder = this.placeholder;
        this.watchingEmptyEl.textContent = this.watchingEmpty;
        this.viewportEl.style.height = `${this.viewportHeight}px`;
        this.searchEl.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.search = this.searchEl.value.trim();
                this.reload();
            }, 200);
        });
        this.viewportEl.addEventListener('scroll', this._onScroll);
        this._renderWatching();
    }

    async _fetch(replace) {
        if (this.loading) return;
        this.loading = true;
        this._setStatus('Loading…');
        try {
            const result = await this.loadItems({ search: this.search, page: this.page });
            const batch = result.items || [];
            this.hasMore = Boolean(result.hasMore);
            this.items = replace ? batch : [...this.items, ...batch];
            this.spacerEl.style.height = `${this.items.length * this.rowHeight}px`;
            this._render();
            const n = this.watching.size;
            this._setStatus(`${this.items.length} result(s)${this.hasMore ? ' · scroll for more' : ''}${n ? ` · watching ${n}` : ''}`);
        } catch (err) {
            this._setStatus(err.message || String(err), true);
        } finally {
            this.loading = false;
        }
    }

    _onScroll() {
        this.scrollTop = this.viewportEl.scrollTop;
        this._render();
        if (!this.loading && this.hasMore) {
            const nearEnd = this.scrollTop + this.viewportHeight >= this.items.length * this.rowHeight - this.rowHeight * 3;
            if (nearEnd) {
                this.page += 1;
                this._fetch(false);
            }
        }
    }

    _renderWatching() {
        const n = this.watching.size;
        this.countEl.textContent = n ? `(${n})` : '';
        this.watchingEmptyEl.style.display = n ? 'none' : 'block';
        if (!n) {
            this.watchingListEl.innerHTML = '';
            return;
        }
        this.watchingListEl.innerHTML = [...this.watching.values()].map((item) => (
            `<div class="wlp-watched" data-id="${escapeHtml(String(item.id))}">` +
            `<span class="wlp-watched-label">${escapeHtml(item.label || item.id)}</span>` +
            (item.sublabel ? `<span class="wlp-watched-sub">${escapeHtml(item.sublabel)}</span>` : '') +
            `<button type="button" class="wlp-remove" title="Remove">×</button></div>`
        )).join('');
        this.watchingListEl.querySelectorAll('.wlp-remove').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const id = e.target.closest('.wlp-watched')?.dataset?.id;
                if (id) this.remove(id);
            });
        });
    }

    _render() {
        const total = this.items.length;
        const start = Math.max(0, Math.floor(this.scrollTop / this.rowHeight) - 5);
        const visible = Math.ceil(this.viewportHeight / this.rowHeight) + 10;
        const end = Math.min(total, start + visible);

        if (!total) {
            this.rowsEl.style.transform = '';
            this.rowsEl.innerHTML = `<div class="wlp-empty">${escapeHtml(this.emptyText)}</div>`;
            return;
        }

        this.rowsEl.style.transform = `translateY(${start * this.rowHeight}px)`;
        const html = [];
        for (let i = start; i < end; i++) {
            const item = this.items[i];
            const id = String(item.id);
            const added = this.watching.has(id);
            const sub = item.sublabel ? `<span class="wlp-sub">${escapeHtml(item.sublabel)}</span>` : '';
            html.push(
                `<div class="wlp-row${added ? ' added' : ''}" style="top:${(i - start) * this.rowHeight}px" data-id="${escapeHtml(id)}">` +
                `<span class="wlp-label">${escapeHtml(item.label || id)}</span>${sub}` +
                `<button type="button" class="wlp-add" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button></div>`,
            );
        }
        this.rowsEl.innerHTML = html.join('');
        this.rowsEl.querySelectorAll('.wlp-add:not([disabled])').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const row = e.target.closest('.wlp-row');
                const id = row?.dataset?.id;
                const item = this.items.find((x) => String(x.id) === id);
                if (item) this.add(item);
            });
        });
    }

    _setStatus(text, isErr) {
        this.statusEl.textContent = text || '';
        this.statusEl.className = isErr ? 'wlp-status err' : 'wlp-status';
    }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

if (typeof module !== 'undefined') module.exports = { WatchListPicker, escapeHtml };
