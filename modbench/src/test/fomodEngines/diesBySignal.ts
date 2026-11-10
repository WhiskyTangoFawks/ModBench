process.on('message', () => process.kill(process.pid, 'SIGSEGV'));
