using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A write that landed and that the record index has not read: answered as written, and logged.</summary>
public static class UnreadWrite
{
    public static void Log(ILogger logger, string reason) =>
        logger.LogWarning("A write landed that the record index has not read: {Message}", reason);
}
