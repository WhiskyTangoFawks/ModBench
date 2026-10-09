using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The changes that move the plugin's source and the name its tree was filed under, or why nothing changed.</summary>
public abstract record RenameSourceResult
{
    private RenameSourceResult()
    {
    }

    internal static RenameSourceResult Landed(SourceChanges changes, string treeName) => new LandedResult(changes, treeName);

    internal static RenameSourceResult Refused(RenameSourceRefusal refusal, string message) => new RefusedResult(refusal, message);

    /// <summary>What <paramref name="landed"/> or <paramref name="refused"/> makes of this result.</summary>
    public abstract T Match<T>(Func<SourceChanges, string, T> landed, Func<RenameSourceRefusal, string, T> refused);

    private sealed record LandedResult(SourceChanges Made, string Tree) : RenameSourceResult
    {
        public override T Match<T>(Func<SourceChanges, string, T> landed, Func<RenameSourceRefusal, string, T> refused) =>
            landed(Made, Tree);
    }

    private sealed record RefusedResult(RenameSourceRefusal Why, string Reason) : RenameSourceResult
    {
        public override T Match<T>(Func<SourceChanges, string, T> landed, Func<RenameSourceRefusal, string, T> refused) =>
            refused(Why, Reason);
    }
}

/// <summary>Whether what Modbench last wrote moved, or why it did not.</summary>
public sealed record MoveLastWrittenResult(RenameSourceRefusal? Refusal = null, string? Message = null);

/// <summary>Why a step of renaming a plugin's source wrote nothing (ADR-0019): each value is a different way out.</summary>
public enum RenameSourceRefusal
{
    /// <summary>The new name does not end <c>.esp</c>, <c>.esm</c> or <c>.esl</c>.</summary>
    NotAPluginFile,

    /// <summary>No loaded plugin is the file name and origin the gesture named.</summary>
    PluginNotLoaded,

    /// <summary>The plugin has no plugin source, so there is none to rename.</summary>
    NotTracked,

    /// <summary>A plugin source of the mod already holds the new name, compared without case.</summary>
    NameTaken,

    /// <summary>A file of the plugin source is no JSON document; the way out is mending it.</summary>
    UnreadableSource,

    /// <summary>git is not on PATH (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>git or the file system refused the write, and the source is put back.</summary>
    WriteFailed,
}
