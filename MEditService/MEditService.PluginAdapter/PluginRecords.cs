using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's binary read as the source tree it would commit, beside its header's masters and
/// the hash of the bytes it was read from, as the commit trailers spell it (ADR-0003).</summary>
public sealed record PluginSource(IReadOnlyList<TreeFile> Files, IReadOnlyList<string> Masters, string BinarySha256);

/// <summary>One plugin's records looked up a few at a time. Mutagen reads a record only when asked,
/// so each answer carries its own failure. Owns the open until disposed.</summary>
public interface IPluginRecords : IDisposable
{
    /// <summary>The record type and EditorID the plugin's copy gives <paramref name="formKey"/>,
    /// without serializing the record; null when it holds nothing under that key.</summary>
    PluginAnswer<RecordIdentity?> IdentityOf(string formKey);

    /// <summary>The record header's flags, read without its fields; null when the plugin holds
    /// nothing under that key.</summary>
    PluginAnswer<long?> RecordFlagsOf(string formKey);

    /// <summary>The record's own document, or null when the plugin holds nothing under that
    /// key.</summary>
    PluginAnswer<string?> TextOf(string formKey);

    /// <summary>The container whose own document carries <paramref name="formKey"/> inline, and the
    /// slot it sits in; null when the record has a document of its own.</summary>
    PluginAnswer<DocumentContainment?> ContainmentOf(string formKey);

    /// <summary>Where the GRUP hierarchy puts the cell <paramref name="formKey"/> names, or null when the plugin holds no cell under that key.</summary>
    PluginAnswer<CellStructure?> CellStructureOf(string formKey);

    /// <summary>The FormKey of the exterior cell the plugin holds at grid (<paramref name="x"/>,
    /// <paramref name="y"/>) of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    PluginAnswer<string?> CellAt(string worldspace, int x, int y);
}
