export const AppBar = ({ showHome }: { readonly showHome: boolean }) => (
  <header className="appbar">
    <div className="appbar-left">
      <a href="#/" className="wordmark" aria-label="TiDB Integration Lab, all demos">
        <svg className="wordmark-mark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 1.5 21.5 7v10L12 22.5 2.5 17V7z" />
          <path className="wordmark-cut" d="M8 8h8v2.6h-2.7V17h-2.6v-6.4H8z" />
        </svg>
        <span className="wordmark-text">
          Ti<span className="wordmark-db">DB</span>
        </span>
        <span className="wordmark-sep" aria-hidden="true">·</span>
        <span className="wordmark-product">Integration Lab</span>
      </a>
      {showHome && <a href="#/" className="navhome">All demos</a>}
    </div>
  </header>
);
