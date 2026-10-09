using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The tests' view of the tree's files: where a record's document sits, what lies under a
/// directory, and states no record operation reaches. The only place the tests name a placed file.</summary>
internal static class TreeTampering
{
    internal static string FileOf(string modFolder, PluginAddress plugin, RecordIdentity identity)
    {
        var relativePath = TrackedTree.Repository(modFolder).RelativePathOf(plugin, identity)
            ?? throw new InvalidOperationException($"Expected a document in '{modFolder}' to hold {identity.FormKey}.");
        return Path.Combine(modFolder, relativePath);
    }

    /// <summary>The directory holding the record's document: a container's own directory.</summary>
    internal static string DirectoryOf(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        FolderOf(FileOf(modFolder, plugin, identity));

    /// <summary>The block directory holding an exterior cell's sub-block, cell directory and document.</summary>
    internal static string BlockDirectoryOf(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        FolderOf(FolderOf(DirectoryOf(modFolder, plugin, identity)));

    internal static DateTime LastWrittenAt(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        File.GetLastWriteTimeUtc(FileOf(modFolder, plugin, identity));

    /// <summary>Every file under <paramref name="directory"/> with its text, by path within it.</summary>
    internal static SortedDictionary<string, string> FilesUnder(string directory) =>
        Directory.Exists(directory)
            ? new(Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories)
                .ToDictionary(file => Path.GetRelativePath(directory, file), File.ReadAllText), StringComparer.Ordinal)
            : new(StringComparer.Ordinal);

    /// <summary>A directory where the record's document would be written, so the write fails.</summary>
    internal static void BlockWrite(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        Directory.CreateDirectory(FileOf(modFolder, plugin, identity));

    /// <summary><see cref="BlockWrite"/> in <paramref name="to"/>'s tree, at the place the record's document has in
    /// <paramref name="from"/>'s, so a copy of the record from one to the other fails on that document.</summary>
    internal static void BlockWriteAsPlacedIn(
        string fromModFolder, PluginAddress from, RecordIdentity identity, string toModFolder, PluginAddress to) =>
        Directory.CreateDirectory(Path.Combine(
            PluginSourceRoot.In(toModFolder, to.Name),
            Path.GetRelativePath(PluginSourceRoot.In(fromModFolder, from.Name), FileOf(fromModFolder, from, identity))));

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

    /// <summary>The record's container document copied under a sibling directory, so two container
    /// directories claim one FormKey.</summary>
    internal static string DuplicateInSiblingDirectory(string modFolder, PluginAddress plugin, RecordIdentity identity)
    {
        var original = FileOf(modFolder, plugin, identity);
        var directory = FolderOf(original);
        var sibling = Path.Combine(
            FolderOf(directory), "Impostor - " + Path.GetFileName(directory).Split(" - ")[1]);
        Directory.CreateDirectory(sibling);
        var copy = Path.Combine(sibling, Path.GetFileName(original));
        File.Copy(original, copy);
        return copy;
    }

    /// <summary>A group document in the record's folder: the shape of a file Track never writes
    /// there.</summary>
    internal static string StrayGroupDocument(string modFolder, PluginAddress plugin, RecordIdentity identity) =>
        Stray(modFolder, plugin, identity, "GroupRecordData.json", "{}");

    /// <summary>A file in the record's folder that no record occupies.</summary>
    internal static string Stray(string modFolder, PluginAddress plugin, RecordIdentity identity, string fileName, string text)
    {
        var stray = Path.Combine(FolderOf(FileOf(modFolder, plugin, identity)), fileName);
        File.WriteAllText(stray, text);
        return stray;
    }

    /// <summary>The plugin header's document, relative to its mod folder.</summary>
    internal static string HeaderDocumentOf(string pluginFileName) =>
        PluginSourceRoot.HeaderDocument(pluginFileName);

    /// <summary>The block and sub-block folders the exterior cell's document sits in, as the whole-mod
    /// serializer names them.</summary>
    internal static void AssertCellSitsInBlocks(
        string modFolder, PluginAddress plugin, RecordIdentity cell, int blockX, int blockY, int subX, int subY)
    {
        var blocks = Path.Combine($"{blockX}, {blockY}", $"{subX}, {subY}") + Path.DirectorySeparatorChar;
        Assert.Contains(
            blocks, TrackedTree.Repository(modFolder).RelativePathOf(plugin, cell), StringComparison.Ordinal);
    }

    /// <summary>A document that names <paramref name="formKey"/> in an embedded slot of a record that cannot
    /// carry it, so the tree uses the key and no record answers to it.</summary>
    internal static void NameInAnUnplaceableChild(string modFolder, PluginAddress plugin, string formKey)
    {
        var folder = Path.Combine(
            modFolder, PluginSourceRoot.For(plugin.Name),
            RecordTypes.For(GameRelease.Fallout4).GroupOf("globalfloat").Require());
        Directory.CreateDirectory(folder);
        File.WriteAllText(
            Path.Combine(folder, $"Carrier - 00A000_{plugin.Name}.json"),
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:" + plugin.Name + "\",\n" +
            "  \"Temporary\": [ { \"FormKey\": \"" + formKey + "\" } ]\n}");
    }

    private static string FolderOf(string file) =>
        Path.GetDirectoryName(file) ?? throw new InvalidOperationException($"Expected '{file}' to have a parent directory.");
}
