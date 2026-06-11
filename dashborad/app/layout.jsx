import './globals.css';

import { NavProvider } from './components/NavProvider';

export const metadata = {
  title: 'MagicHat Campaign Dashboard',
  description: 'Operational dashboard for MagicHat outbound runs',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <NavProvider>{children}</NavProvider>
      </body>
    </html>
  );
}
