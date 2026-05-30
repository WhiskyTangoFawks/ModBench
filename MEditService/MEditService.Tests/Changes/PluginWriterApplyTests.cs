using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Changes;

/// <summary>
/// Tests the Apply lambdas stored in ColumnSpec — the functions that write JsonElement values
/// back onto Mutagen record objects. These are the core of the write path in PluginWriter.
/// </summary>
public class PluginWriterApplyTests
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas =
        _reflector.GetSchemas(GameRelease.Fallout4);

    private static Npc MakeNpc() =>
        new(FormKey.Factory("000001:TestPlugin.esp"), Fallout4Release.Fallout4);

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static Core.Schema.ColumnSpec Col(string table, string column) =>
        _schemas[table].RecordColumns.Single(c => c.Name == column);

    // --- bool ---

    [Fact]
    public void Apply_Bool_SetsPropertyToTrue()
    {
        var col = Col("npc_", "aggro_radius_behavior_enabled");
        var npc = MakeNpc();
        npc.AggroRadiusBehaviorEnabled = false;

        col.Apply!(npc, J("true"));

        Assert.True(npc.AggroRadiusBehaviorEnabled);
    }

    [Fact]
    public void Apply_Bool_SetsPropertyToFalse()
    {
        var col = Col("npc_", "aggro_radius_behavior_enabled");
        var npc = MakeNpc();
        npc.AggroRadiusBehaviorEnabled = true;

        col.Apply!(npc, J("false"));

        Assert.False(npc.AggroRadiusBehaviorEnabled);
    }

    // --- short (Int16 — covers all integer types via same MakeApply branch) ---

    [Fact]
    public void Apply_Short_SetsPropertyToValue()
    {
        var col = Col("npc_", "xp_value_offset");
        var npc = MakeNpc();
        npc.XpValueOffset = 0;

        col.Apply!(npc, J("42"));

        Assert.Equal((short)42, npc.XpValueOffset);
    }

    [Fact]
    public void Apply_Short_NegativeValue()
    {
        var col = Col("npc_", "xp_value_offset");
        var npc = MakeNpc();

        col.Apply!(npc, J("-10"));

        Assert.Equal((short)-10, npc.XpValueOffset);
    }

    // --- enum ---

    [Fact]
    public void Apply_Enum_SetsPropertyByName()
    {
        var col = Col("npc_", "aggression");
        var npc = MakeNpc();
        npc.Aggression = Npc.AggressionType.Unaggressive;

        col.Apply!(npc, J("\"VeryAggressive\""));

        Assert.Equal(Npc.AggressionType.VeryAggressive, npc.Aggression);
    }

    [Fact]
    public void Apply_Enum_CaseInsensitive()
    {
        var col = Col("npc_", "aggression");
        var npc = MakeNpc();

        col.Apply!(npc, J("\"frenzied\""));

        Assert.Equal(Npc.AggressionType.Frenzied, npc.Aggression);
    }

    // --- TranslatedString ---

    [Fact]
    public void Apply_TranslatedString_SetsName()
    {
        var col = Col("npc_", "name");
        var npc = MakeNpc();

        col.Apply!(npc, J("\"Test NPC Name\""));

        Assert.Equal("Test NPC Name", npc.Name?.String);
    }

    [Fact]
    public void Apply_TranslatedString_NullClearsName()
    {
        var col = Col("npc_", "name");
        var npc = MakeNpc();
        npc.Name = new Mutagen.Bethesda.Strings.TranslatedString(
            Mutagen.Bethesda.Strings.Language.English, "Old Name");

        col.Apply!(npc, J("null"));

        Assert.Null(npc.Name);
    }

    // --- FormLink (Apply must be null — write is not supported) ---

    [Fact]
    public void Apply_FormLink_IsNull()
    {
        var col = Col("npc_", "race");
        Assert.Null(col.Apply);
    }

    [Fact]
    public void Apply_FormLink_TryApplyField_ReturnsFalse()
    {
        var col = Col("npc_", "race");
        // Apply == null means TryApplyField in PluginWriter will skip this field
        Assert.False(col.Apply != null);
    }

    // --- SaveResult outcome tests ---

    private static PendingChange MakeChange(FormKey formKey, string fieldPath, string json) =>
        new(Guid.NewGuid(), formKey.ToString(), "TestPlugin.esp", fieldPath, "npc_",
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow);

    private static (string pluginPath, IRecordRepository repo, FormKey npcKey) BuildFixture()
    {
        var reflector = new SchemaReflector();
        var mapper = new FieldMetadataMapper();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("pw-apply")
            .WithPlugin("TestPlugin.esp", mod => npcKey = mod.Npcs.AddNew("ApplyTestNPC").FormKey)
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modPath = new ModPath(ModKey.FromFileName("TestPlugin.esp"), pluginPath);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);

        var repo = new InMemoryRecordRepository(reflector, mapper);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();

        return (pluginPath, repo, npcKey);
    }

    [Fact]
    public async Task SaveAsync_WritableField_AppearsInApplied()
    {
        var (pluginPath, repo, npcKey) = BuildFixture();
        using (repo)
        {
            var writer = new PluginWriter(_reflector);
            // "aggression" is an enum column with an Apply function
            var change = MakeChange(npcKey, "aggression", "\"Frenzied\"");

            var result = await writer.SaveAsync(pluginPath, [change], repo, 0, GameRelease.Fallout4);

            Assert.Contains("aggression", result.Applied);
            Assert.Empty(result.ReadOnly);
            Assert.Empty(result.NotFound);
            Assert.NotNull(result.BackupPath);
        }
    }

    [Fact]
    public async Task SaveAsync_FormLinkField_AppearsInReadOnly()
    {
        var (pluginPath, repo, npcKey) = BuildFixture();
        using (repo)
        {
            var writer = new PluginWriter(_reflector);
            var change = MakeChange(npcKey, "race", "\"000001:Fallout4.esm\"");

            var result = await writer.SaveAsync(pluginPath, [change], repo, 0, GameRelease.Fallout4);

            Assert.Contains("race", result.ReadOnly);
            Assert.Empty(result.Applied);
            Assert.Empty(result.NotFound);
        }
    }

    [Fact]
    public async Task SaveAsync_UnknownField_AppearsInNotFound()
    {
        var (pluginPath, repo, npcKey) = BuildFixture();
        using (repo)
        {
            var writer = new PluginWriter(_reflector);
            var change = MakeChange(npcKey, "nonexistent_field", "\"value\"");

            var result = await writer.SaveAsync(pluginPath, [change], repo, 0, GameRelease.Fallout4);

            Assert.Contains("nonexistent_field", result.NotFound);
            Assert.Empty(result.Applied);
            Assert.Empty(result.ReadOnly);
        }
    }

    // --- IsReadOnly ---

    [Fact]
    public void IsReadOnly_FormLinkField_ReturnsTrue()
    {
        var writer = new PluginWriter(_reflector);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "npc_", "race"));
    }

    [Fact]
    public void IsReadOnly_BoolField_ReturnsFalse()
    {
        var writer = new PluginWriter(_reflector);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "npc_", "aggro_radius_behavior_enabled"));
    }

    [Fact]
    public void IsReadOnly_UnknownRecordType_ReturnsTrue()
    {
        var writer = new PluginWriter(_reflector);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "nonexistent_type", "some_field"));
    }

    [Fact]
    public void IsReadOnly_UnknownField_ReturnsTrue()
    {
        var writer = new PluginWriter(_reflector);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "npc_", "nonexistent_field"));
    }
}
