namespace MEditService.Codec.Schema;

/// <summary>Why an edit by path cannot be made on a document, at the path it names.</summary>
public abstract record EditFailure(string Path)
{
    public sealed record NoField(string Path, string Owner, string Field) : EditFailure(Path);

    public sealed record NoMember(string Path, string Owner, string Member) : EditFailure(Path);

    public sealed record NoMembers(string Path, string Subject) : EditFailure(Path);

    public sealed record Absent(string Path, string Subject) : EditFailure(Path);

    public sealed record NotAnArray(string Path, string Subject, bool InTheDocument) : EditFailure(Path);

    public sealed record NoArrayToAppendTo(string Path) : EditFailure(Path);

    public sealed record NoElement(string Path, int Count) : EditFailure(Path);

    public sealed record NullElement(string Path) : EditFailure(Path);

    /// <summary>A value that does not lead with the discriminator naming one of its leaves.</summary>
    public sealed record NotALeaf(string Path, FieldMetadata Discriminator) : EditFailure(Path);

    public sealed record KeyedMove(string Path, string Array) : EditFailure(Path);

    public sealed record AlreadyThere(string Path, int Position) : EditFailure(Path);

    public sealed record NotABoolean(string Path) : EditFailure(Path);

    public sealed record ReadOnlyMember(string Path, string Member, string Reason) : EditFailure(Path);

    /// <summary>A hex value of another length than the bytes the document holds there.</summary>
    public sealed record HexResize(string Path, int Held, int Given) : EditFailure(Path);

    /// <summary>A colour giving an alpha where the field holds none.</summary>
    public sealed record AlphaGiven(string Path, string Color) : EditFailure(Path);
}
