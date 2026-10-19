import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cn.lumaretouch.app',
  appName: '光修 AI',
  webDir: 'dist',
  android: { allowMixedContent: false, backgroundColor: '#111217' },
  server: { androidScheme: 'https' },
};

export default config;
