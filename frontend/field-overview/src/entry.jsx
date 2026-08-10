import React from 'react';
import { createRoot } from 'react-dom/client';
import { FieldOverviewApp } from './FieldOverviewApp.jsx';
import './styles.css';

const roots = new WeakMap();

class OverviewBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error) {
    if (typeof this.props.onError === 'function') this.props.onError(error);
  }

  render() { return this.state.failed ? null : this.props.children; }
}

function mount(container, options = {}) {
  if (!container || typeof container !== 'object') return false;
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(
    <OverviewBoundary onError={options.onError}>
      <FieldOverviewApp
        data={options.data}
        onHospitalSelect={options.onHospitalSelect}
      />
    </OverviewBoundary>,
  );
  return true;
}

function unmount(container) {
  const root = container && roots.get(container);
  if (!root) return false;
  root.unmount();
  roots.delete(container);
  return true;
}

window.IntakeFieldOverview = Object.freeze({ version: '1', mount, unmount });
