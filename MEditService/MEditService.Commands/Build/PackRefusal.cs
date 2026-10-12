namespace MEditService.Commands.Build;

public enum ArchiveRefusal
{
    VariantNotWritten,
    FileNotPackable,
    NotWritten,
}

public sealed record PackRefusal(ArchiveRefusal Reason, string Message);
