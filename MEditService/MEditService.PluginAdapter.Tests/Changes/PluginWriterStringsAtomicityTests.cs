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

    private static Fallout4Mod BuildModifiedMod()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var book = mod.Books.AddNew("TestBook");
        book.Name = new TranslatedString(Language.English, "The New Title");
        book.Description = new TranslatedString(Language.English, "The new description.");
        mod.UsingLocalization = true;
        return mod;
    }

    private static bool IsTheZeroEntryStubTheWriterEmitsForEveryLanguage(string fileName) =>
        fileName.EndsWith(".ILSTRINGS", StringComparison.OrdinalIgnoreCase);

    private Dictionary<string, byte[]> ReadStringsFiles() =>
        Directory.GetFiles(_stringsDir).ToDictionary(f => Path.GetFileName(f), File.ReadAllBytes);

    [Fact]
    public async Task PrepareFromModAsync_LocalizedMod_LeavesFinalStringsFilesUntouchedBeforeCommit_AndNoTempDirectoryOnceDisposedUncommitted()
    {
        var originalFiles = ReadStringsFiles();
        Assert.True(originalFiles.Count >= 2, "fixture should produce at least Normal + DL strings files");

        var modifiedMod = BuildModifiedMod();
        using (var prep = await PluginWriter.PrepareFromModAsync(modifiedMod, _pluginPath))
        {
            var afterPrepare = ReadStringsFiles();
            Assert.Equal(originalFiles.Keys.OrderBy(k => k), afterPrepare.Keys.OrderBy(k => k));
            foreach (var (name, bytes) in originalFiles)
                Assert.True(bytes.AsSpan().SequenceEqual(afterPrepare[name]), $"{name} was modified before Commit()");
        }

        Assert.Empty(Directory.GetDirectories(_dataFolder, ".medit_tmp_*"));
    }

    [Fact]
    public async Task Commit_LocalizedMod_CommitsNewStringsContentAtomically()
    {
        var originalFiles = ReadStringsFiles();

        var modifiedMod = BuildModifiedMod();
        using (var prep = await PluginWriter.PrepareFromModAsync(modifiedMod, _pluginPath))
            prep.Commit();

        var afterCommit = ReadStringsFiles();
        Assert.Equal(originalFiles.Keys.OrderBy(k => k), afterCommit.Keys.OrderBy(k => k));

        foreach (var (name, bytes) in originalFiles.Where(f => !IsTheZeroEntryStubTheWriterEmitsForEveryLanguage(f.Key)))
            Assert.False(bytes.AsSpan().SequenceEqual(afterCommit[name]), $"{name} should differ after Commit() rewrote it");

        Assert.Empty(Directory.GetDirectories(_dataFolder, ".medit_tmp_*"));
    }

    [Fact]
    public async Task Commit_ThatCannotWriteTheStrings_LeavesTheOldBinary()
    {
        var before = File.ReadAllBytes(_pluginPath);

        using (var prep = await PluginWriter.PrepareFromModAsync(BuildModifiedMod(), _pluginPath))
        {
            var tempDir = Assert.Single(Directory.GetDirectories(_dataFolder, ".medit_tmp_*"));
            File.Delete(Directory.GetFiles(Path.Combine(tempDir, "Strings"))[0]);

            Assert.ThrowsAny<IOException>(prep.Commit);
        }

        Assert.Equal(before, File.ReadAllBytes(_pluginPath));
    }
}
