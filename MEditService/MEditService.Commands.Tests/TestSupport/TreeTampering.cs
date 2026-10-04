using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A tree state no record operation can reach: a file beside a record's own, or one held
/// open. The only place the tests name a file the adapter placed.</summary>
internal static class TreeTampering
{
    internal static string FileOf(string modFolder, PluginAddress plugin, RecordIdentity identity)
    {
        var repository = SourceRepository.Open(modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
        var unit = repository.UnitHolding(plugin, identity)
            ?? throw new InvalidOperationException($"Expected a document in '{modFolder}' to hold {identity.FormKey}.");
        return Path.Combine(modFolder, unit.RelativePath);
    }

    /// <summary>A directory where the record's document would be written, so the write fails.</summary>
    internal static void BlockWrite(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        Directory.CreateDirectory(FileOf(modFolder, plugin, identity) + ".tmp");

    /// <summary>The record's document, held open so it cannot be read.</summary>
    internal static FileStream HoldOpen(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        new(FileOf(modFolder, plugin, identity), FileMode.Open, FileAccess.Read, FileShare.None);

    /// <summary>A second file in the record's folder, carrying the record's own text.</summary>
    internal static string Duplicate(string modFolder, PluginAddress plugin, RecordIdentity identity)
    {
        var original = FileOf(modFolder, plugin, identity);
        var copy = Path.Combine(FolderOf(original), $"Copy of {Path.GetFileName(original)}");
        File.Copy(original, copy);
        return copy;
    }

    /// <summary>A file in the record's folder that no record occupies.</summary>
    internal static string Stray(string modFolder, PluginAddress plugin, RecordIdentity identity, string fileName, string text)
    {
        var stray = Path.Combine(FolderOf(FileOf(modFolder, plugin, identity)), fileName);
        File.WriteAllText(stray, text);
        return stray;
    }

    private static string FolderOf(string file) =>
        Path.GetDirectoryName(file) ?? throw new InvalidOperationException($"Expected '{file}' to have a parent directory.");
}
