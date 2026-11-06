import { Component, type ReactNode } from 'react';

/** Un fallo WebGL nunca desmonta la fotografía ni sus marcas. */
export default class Skin3DBoundary extends Component<{ children: ReactNode; onPhoto: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <p>El visor 3D no está disponible en este navegador. La evaluación en la foto continúa disponible.</p>
      <button type="button" className="admin-focus-ring rounded-lg border border-gray-300 bg-white px-3 py-2"
        onClick={this.props.onPhoto}>Seguir en foto 2D</button>
    </div>;
    return this.props.children;
  }
}
