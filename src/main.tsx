import './index.css';
import './sdk/bind-error-sync';
import './sdk/bind-route-sync';
import { renderHome } from './renderer';

window.IframeElementPicker?.child.create({ debug: false }).init();

renderHome();