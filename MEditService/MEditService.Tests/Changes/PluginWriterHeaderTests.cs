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
    private static readonly ISchemaReflector Reflector = new SchemaReflector();

    private const string Plugin = "TestPlugin.esp";
    private static readonly string HeaderFormKey = $"000000:{Plugin}";

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static PendingChange HeaderChange(string fieldPath, string json) =>
        new(Guid.NewGuid(), HeaderFormKey, Plugin, fieldPath, "header",
            J("null"), J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static (string pluginPath, ModPath modPath) BuildFixture(string dir, Action<Fallout4Mod>? setup = null)
    {
        var data = new PluginFixtureBuilder(dir)
            .WithPlugin(Plugin, mod =>
            {
                mod.ModHeader.Author = "Original Author";
                mod.Npcs.AddNew("HeaderTestNpc");
                setup?.Invoke(mod);
            })
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
    public void IsReadOnly_HeaderMasters_ReturnsTrue()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "header", "masters"));
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

    // --- masters stays read-only through the write path ---

    [Fact]
    public async Task SaveAsync_HeaderMasters_AppearsInReadOnly()
    {
        var (pluginPath, _) = BuildFixture("pw-header-masters");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(pluginPath, [HeaderChange("masters", "[\"Fallout4.esm\"]")], GameRelease.Fallout4);

        Assert.Contains("masters", result.ReadOnly);
        Assert.Empty(result.Applied);
    }
}
