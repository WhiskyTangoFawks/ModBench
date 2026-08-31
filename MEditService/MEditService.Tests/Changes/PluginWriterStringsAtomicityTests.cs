using MEditService.Core.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Changes;

/// <summary>
/// A Localized plugin's own <c>.STRINGS</c>/<c>.DLSTRINGS</c>/<c>.ILSTRINGS</c> files get the
/// same temp-write-then-rename discipline <see cref="PreparedPluginSave"/> already gives the
/// <c>.esp</c>/<c>.esm</c> itself (<c>PluginCompileServiceLocalizedTests</c> pins that
/// <c>Commit()</c> lands the strings at all, not that it does so atomically). The fixture only registers content on two sources
/// (<c>Book.Name</c> → Normal/.STRINGS, <c>Book.Description</c> → DL/.DLSTRINGS — FO4's only
/// IL-sourced field, <c>DialogResponse.Text</c>, lives on a nested DialogTopic/DialogResponses group
/// not worth building here), but Mutagen's own <c>StringsWriter.Dispose</c> writes a zero-entry
/// <c>.ILSTRINGS</c> stub for every registered language regardless of source, so a third file rides
/// along for free — all three extensions are exercised by the same untouched-before-Commit and
/// moved-through-Commit assertions below, even though only two carry content that can meaningfully
/// differ.
/// </summary>
public sealed class PluginWriterStringsAtomicityTests : IDisposable
{
    private const string PluginName = "StringsFixture.esp";
    private readonly string _dataFolder = Directory.CreateTempSubdirectory("medit-strings-atomicity-").FullName;
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

    public void Dispose() => Directory.Delete(_dataFolder, recursive: true);

    private static Fallout4Mod BuildModifiedMod()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var book = mod.Books.AddNew("TestBook");
        book.Name = new TranslatedString(Language.English, "The New Title");
        book.Description = new TranslatedString(Language.English, "The new description.");
        mod.UsingLocalization = true;
        return mod;
    }

    private Dictionary<string, byte[]> ReadStringsFiles() =>
        Directory.GetFiles(_stringsDir).ToDictionary(f => Path.GetFileName(f)!, File.ReadAllBytes);

    [Fact]
    public async Task PrepareFromModAsync_LocalizedMod_LeavesFinalStringsFilesUntouchedBeforeCommit()
    {
        var originalFiles = ReadStringsFiles();
        // Sanity: the fixture actually produced both a Normal and a DL strings file — otherwise
        // every assertion below would vacuously pass over an empty/partial set.
        Assert.True(originalFiles.Count >= 2, "fixture should produce at least Normal + DL strings files");

        var modifiedMod = BuildModifiedMod();
        using (var prep = await PluginWriter.PrepareFromModAsync(modifiedMod, _pluginPath))
        {
            // Prepare alone — no Commit() — must not touch the real Strings/ files: the write has to
            // land in a temp location first, exactly like the .esp's own tmpPath.
            var afterPrepare = ReadStringsFiles();
            Assert.Equal(originalFiles.Keys.OrderBy(k => k), afterPrepare.Keys.OrderBy(k => k));
            foreach (var (name, bytes) in originalFiles)
                Assert.True(bytes.AsSpan().SequenceEqual(afterPrepare[name]), $"{name} was modified before Commit()");
        }

        // Disposing without ever calling Commit() must not leak the temp working directory (mirrors
        // the existing SaveAsync_Success_LeavesNoTempSubdirectory guard, now also covering the nested
        // Strings/ temp folder).
        Assert.Empty(Directory.GetDirectories(_dataFolder, ".medit_tmp_*"));
    }

    [Fact]
    public async Task SaveFromModAsync_LocalizedMod_CommitsNewStringsContentAtomically()
    {
        var originalFiles = ReadStringsFiles();

        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);
        var modifiedMod = BuildModifiedMod();
        await writer.SaveFromModAsync(modifiedMod, _pluginPath);

        // Commit() must have moved the new content into the real Strings/ files — same file names,
        // different bytes (a second save of the same plugin: this is the overwrite path, not a
        // first-ever write).
        var afterCommit = ReadStringsFiles();
        Assert.Equal(originalFiles.Keys.OrderBy(k => k), afterCommit.Keys.OrderBy(k => k));

        // Only the sources this fixture actually populates (Normal via Name, DL via Description) are
        // expected to differ. StringsWriter also emits a zero-entry .ILSTRINGS stub for every
        // registered language regardless of source (Dispose's own `languages` union), so that file's
        // bytes are identical on both saves by construction — its presence above (same file set,
        // moved through the same temp dir with no leftover) is what proves it went through Commit()
        // too, not a content diff that can never fire for an always-empty file.
        foreach (var (name, bytes) in originalFiles.Where(f => !f.Key.EndsWith(".ILSTRINGS", StringComparison.OrdinalIgnoreCase)))
            Assert.False(bytes.AsSpan().SequenceEqual(afterCommit[name]), $"{name} should differ after Commit() rewrote it");

        Assert.Empty(Directory.GetDirectories(_dataFolder, ".medit_tmp_*"));
    }
}
