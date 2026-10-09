using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Index;

internal static class UnreadableSources
{
    private const string Unsaid = "The plugin source could not be read.";

    internal static UnreadableSource Of(SourceFailure failure) => new(Said(failure.Reason), failure.DecompileRepairs);

    internal static UnreadableSource Of(Exception error) =>
        new(Said(error.Message), DecompileRepairs: error is not (IOException or UnauthorizedAccessException));

    internal static UnreadableSource Unknown => new(Unsaid, DecompileRepairs: false);

    private static string Said(string reason) => string.IsNullOrWhiteSpace(reason) ? Unsaid : reason;
}
