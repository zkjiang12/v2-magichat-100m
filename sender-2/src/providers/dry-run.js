export function createDryRunProvider() {
  return {
    name: 'dry-run',
    async sendMessage({ creator, message }) {
      return {
        skipped: false,
        provider: 'dry-run',
        handle: creator.handle,
        message,
      };
    },
  };
}
