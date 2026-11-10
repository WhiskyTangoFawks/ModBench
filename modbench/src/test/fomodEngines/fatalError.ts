process.on('message', () => {
  process.stderr.write(
    '<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n----- Native stack trace -----\n5: processTicksAndRejections\n',
    () => process.exit(134),
  );
});
