using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.Changes;

public sealed class PluginWriterStringsAtomicityTests : IDisposable
{
    private const string PluginName = "StringsFixture.esp";
    private readonly ScratchDirectory _dataFolder = new("medit-strings-atomicity-");
    private readonly string _pluginPath;
    private readonly string _stringsDir;

    public PluginWriterStringsAtomicityTests()
    {
        _pluginPath = Path.Combine(_dataFolder, PluginName);
        _stringsDir = Path.Combine(_dataFolder, "Strings");

        var original = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var book = original.Books.AddNew("TestBook");
        book.Name = new TranslatedString(Language.English, "The Original Title");
        book.Description = new TranslatedString(Language.English, "The original description.");
        original.UsingLocalization = true;
        original.WriteToBinary(_pluginPath);
    }

    public void Dispose() => _dataFolder.Dispose();

    private Task<PreparedPluginSave> PrepareModifiedAsync() => TreeSaves.PrepareAsync(
        _pluginPath,
        loadOrder: null,
        ("The Original Title", "The New Title"),
        ("The original description.", "The new description."));

    private static bool IsTheZeroEntryStubTheWriterEmitsForEveryLanguage(string fileName) =>
        fileName.EndsWith(".ILSTRINGS", StringComparison.OrdinalIgnoreCase);

    private Dictionary<string, byte[]> ReadStringsFiles() =>
        Directory.GetFiles(_stringsDir).ToDictionary(f => Path.GetFileName(f), File.ReadAllBytes);

    [Fact]
    public async Task PrepareSaveAsync_LocalizedMod_LeavesFinalStringsFilesUntouchedBeforeCommit_AndTheDataFolderAsItWasOnceDisposedUncommitted()
    {
        var originalFiles = ReadStringsFiles();
        var entriesBefore = FolderEntries.Of(_dataFolder);
        Assert.True(originalFiles.Count >= 2, "fixture should produce at least Normal + DL strings files");

        using (var prep = await PrepareModifiedAsync())
        {
            var afterPrepare = ReadStringsFiles();
            Assert.Equal(originalFiles.Keys.OrderBy(k => k), afterPrepare.Keys.OrderBy(k => k));
            foreach (var (name, bytes) in originalFiles)
                Assert.True(bytes.AsSpan().SequenceEqual(afterPrepare[name]), $"{name} was modified before Commit()");
        }

        Assert.Equal(entriesBefore, FolderEntries.Of(_dataFolder));
    }

    [Fact]
    public async Task Commit_LocalizedMod_CommitsNewStringsContentAtomically()
    {
        var originalFiles = ReadStringsFiles();
        var entriesBefore = FolderEntries.Of(_dataFolder);

        using (var prep = await PrepareModifiedAsync())
            prep.Commit();

        var afterCommit = ReadStringsFiles();
        Assert.Equal(originalFiles.Keys.OrderBy(k => k), afterCommit.Keys.OrderBy(k => k));

        foreach (var (name, bytes) in originalFiles.Where(f => !IsTheZeroEntryStubTheWriterEmitsForEveryLanguage(f.Key)))
            Assert.False(bytes.AsSpan().SequenceEqual(afterCommit[name]), $"{name} should differ after Commit() rewrote it");

        Assert.Equal(entriesBefore, FolderEntries.Of(_dataFolder));
    }

    [Fact]
    public async Task Commit_ThatCannotWriteTheStrings_LeavesTheOldBinary()
    {
        var before = File.ReadAllBytes(_pluginPath);

        using (var prep = await PrepareModifiedAsync())
        {
            FileModes.Set(_stringsDir, "555");
            try
            {
                Assert.ThrowsAny<Exception>(prep.Commit);
            }
            finally
            {
                FileModes.Set(_stringsDir, "755");
            }
        }

        Assert.Equal(before, File.ReadAllBytes(_pluginPath));
    }
}
