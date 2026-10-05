namespace MEditService.Commands;

/// <summary>Whether rename source moved the plugin's source, or why it wrote nothing.</summary>
public sealed record RenameSourceResult(RenameSourceRefusal? Refusal = null, string? Message = null)
{
    public bool Applied => Refusal is null;
}

/// <summary>Why rename source wrote nothing (ADR-0019): each value is a different way out.</summary>
public enum RenameSourceRefusal
{
    /// <summary>The new name does not end <c>.esp</c>, <c>.esm</c> or <c>.esl</c>.</summary>
    NotAPluginFile,

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
