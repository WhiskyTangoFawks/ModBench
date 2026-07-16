using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Changes;

/// <summary>
/// Header edits (issue #85): the writer applies author/flags onto the mod's ModHeader — which is
/// not an IMajorRecord, so it takes a dedicated apply path keyed on RecordType == "header".
/// </summary>
public sealed class PluginWriterHeaderTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;

    private const string Plugin = "TestPlugin.esp";
    private static readonly string HeaderFormKey = $"000000:{Plugin}";

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static PendingChange HeaderChange(string fieldPath, string json) =>
        new(Guid.NewGuid(), HeaderFormKey, Plugin, fieldPath, "header",
            J("null"), J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static (string pluginPath, ModPath modPath) BuildFixture(
        string dir,
        Action<Fallout4Mod>? setup = null,
        Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters? writeParams = null)
    {
        var data = new PluginFixtureBuilder(dir)
            .WithPlugin(
                Plugin,
                mod =>
                {
                    mod.ModHeader.Author = "Original Author";
                    mod.Npcs.AddNew("HeaderTestNpc");
                    setup?.Invoke(mod);
                },
                writeParams: writeParams)
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, Plugin);
        return (pluginPath, new ModPath(ModKey.FromFileName(Plugin), pluginPath));
    }

    // --- IsReadOnly (slice 2) ---

    [Fact]
    public void IsReadOnly_HeaderAuthor_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "header", "author"));
    }

    [Fact]
    public void IsReadOnly_HeaderFlags_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "header", "flags"));
    }

    [Fact]
    public void IsReadOnly_HeaderMasters_ReturnsFalse()
    {
        // Issue #86: masters becomes a writable (add-only) header column.
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "header", "masters"));
    }

    [Fact]
    public void IsReadOnly_HeaderUnknownField_ReturnsTrue()
    {
        // A header field absent from the schema has no apply delegate → read-only (not editable),
        // and the index lookup must return "not found" rather than run past the column list.
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "header", "no_such_header_field"));
    }

    // --- Save author round-trip (slice 3) ---

    [Fact]
    public async Task SaveAsync_HeaderAuthor_WritesModHeaderAuthor()
    {
        var (pluginPath, modPath) = BuildFixture("pw-header-author");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(pluginPath, [HeaderChange("author", "\"New Author\"")], GameRelease.Fallout4);

        Assert.Contains("author", result.Applied);
        Assert.Empty(result.NotFound);
        Assert.Empty(result.ReadOnly);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.Equal("New Author", saved.ModHeader.Author);
    }

    // --- Save flags round-trip: ESM (slice 4) ---

    [Fact]
    public async Task SaveAsync_HeaderFlags_SetsMasterFlag()
    {
        var (pluginPath, modPath) = BuildFixture("pw-header-esm");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        var masterBit = ((long)Fallout4ModHeader.HeaderFlag.Master).ToString(System.Globalization.CultureInfo.InvariantCulture);

        var result = await writer.SaveAsync(pluginPath, [HeaderChange("flags", $"\"{masterBit}\"")], GameRelease.Fallout4);

        Assert.Contains("flags", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.True(saved.ModHeader.Flags.HasFlag(Fallout4ModHeader.HeaderFlag.Master));
    }

    // --- Save flags round-trip: ESL (slice 4) ---

    [Fact]
    public async Task SaveAsync_HeaderFlags_SetsSmallFlag()
    {
        var (pluginPath, modPath) = BuildFixture("pw-header-esl");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        var smallBit = ((long)Fallout4ModHeader.HeaderFlag.Small).ToString(System.Globalization.CultureInfo.InvariantCulture);

        var result = await writer.SaveAsync(pluginPath, [HeaderChange("flags", $"\"{smallBit}\"")], GameRelease.Fallout4);

        Assert.Contains("flags", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.True(saved.ModHeader.Flags.HasFlag(Fallout4ModHeader.HeaderFlag.Small));
    }

    // --- Save masters round-trip (issue #86) ---

    [Fact]
    public async Task SaveAsync_HeaderMasters_WritesModMasterReferences()
    {
        var (pluginPath, modPath) = BuildFixture("pw-header-masters", mod =>
            ((IMod)mod).MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") }));
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(
            pluginPath,
            [HeaderChange("masters", "[\"Fallout4.esm\",\"DLCRobot.esm\"]")],
            GameRelease.Fallout4);

        Assert.Contains("masters", result.Applied);
        Assert.Empty(result.ReadOnly);
        Assert.Empty(result.NotFound);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.Equal(
            ["Fallout4.esm", "DLCRobot.esm"],
            saved.MasterReferences.Select(r => r.Master.FileName.ToString()));
    }

    // --- HasMastersEdit scoping (issue #86): the NoCheck override only kicks in for a save that
    // actually stages a masters field-edit — a save touching some *other* header field must still
    // go through Mutagen's default content-derived master sync, so an unreferenced declared master
    // gets pruned exactly as it would pre-#86. ---

    [Fact]
    public async Task SaveAsync_AuthorOnly_LeavesUnreferencedMasterPrunedByDefaultSync()
    {
        var (pluginPath, modPath) = BuildFixture(
            "pw-header-author-only-prunes-master",
            mod => ((IMod)mod).MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") }),
            // Preserve the unreferenced declared master through the *fixture's own* build write, so
            // the plugin genuinely starts with it declared before the write-under-test runs.
            writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
            {
                MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
            });
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        // Only an author edit is staged — no masters change — so HasMastersEdit must be false and
        // the save must fall through to Mutagen's default Iterate sync, which drops the unreferenced
        // "Fallout4.esm" master (nothing in the plugin's content references it).
        var result = await writer.SaveAsync(pluginPath, [HeaderChange("author", "\"New Author\"")], GameRelease.Fallout4);

        Assert.Contains("author", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.Empty(saved.MasterReferences);
    }

    [Fact]
    public async Task SaveAsync_AuthorAndMastersTogether_MastersSurvivesAmongMultipleChanges()
    {
        var (pluginPath, modPath) = BuildFixture("pw-header-author-and-masters");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        // Two staged changes, only one of which touches masters — HasMastersEdit must still find
        // it (Any semantics), not require every change in the batch to touch masters (All).
        var changes = new[]
        {
            HeaderChange("author", "\"New Author\""),
            HeaderChange("masters", "[\"DLCRobot.esm\"]"),
        };

        var result = await writer.SaveAsync(pluginPath, changes, GameRelease.Fallout4);

        Assert.Contains("author", result.Applied);
        Assert.Contains("masters", result.Applied);

        using var saved = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.Equal("New Author", saved.ModHeader.Author);
        // DLCRobot.esm is unreferenced by any content — it only survives if NoCheck was applied.
        Assert.Equal(["DLCRobot.esm"], saved.MasterReferences.Select(r => r.Master.FileName.ToString()));
    }
}
