import React from 'react';
import { createRoot } from 'react-dom/client';
import {DesktopRoot} from './DesktopRoot';
import './style.css';
import './controls.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><DesktopRoot /></React.StrictMode>);
