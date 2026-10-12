namespace MEditService.Commands.Build;

/// <summary>A file for an archive: its name inside the archive, lowercased with backslashes, and how to read it.
/// The source path is the one a refusal names.</summary>
internal sealed record PackedFile(string Source, string Name, Func<Stream> Open)
{
    public string Folder => Name.Contains('\\') ? Name[..Name.LastIndexOf('\\')] : string.Empty;

    public string FileName => Name[(Name.LastIndexOf('\\') + 1)..];

    public string Stem => FileName[..ExtensionStart];

    public string Extension => FileName[ExtensionStart..];

    private int ExtensionStart => FileName.LastIndexOf('.') is var dot and >= 0 && dot < FileName.Length - 1 ? dot : FileName.Length;
}
