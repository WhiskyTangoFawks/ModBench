using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
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

    private static PendingChange MakeChangeRaw(string rawFormKey, string fieldPath, string json) =>
        new(Guid.NewGuid(), rawFormKey, "TestPlugin.esp", fieldPath, "npc_",
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow);

    private static (string pluginPath, FormKey npcKey) BuildFixture()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("pw-apply")
            .WithPlugin("TestPlugin.esp", mod => npcKey = mod.Npcs.AddNew("ApplyTestNPC").FormKey)
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        return (pluginPath, npcKey);
    }

    [Fact]
    public async Task SaveAsync_WritableField_AppearsInApplied()
    {
        var (pluginPath, npcKey) = BuildFixture();
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var change = MakeChange(npcKey, "aggression", "\"Frenzied\"");

        var result = await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        Assert.Contains("aggression", result.Applied);
        Assert.Empty(result.ReadOnly);
        Assert.Empty(result.NotFound);
        Assert.NotNull(result.BackupPath);
    }

    [Fact]
    public async Task SaveAsync_FormLinkField_AppearsInReadOnly()
    {
        var (pluginPath, npcKey) = BuildFixture();
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var change = MakeChange(npcKey, "race", "\"000001:Fallout4.esm\"");

        var result = await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        Assert.Contains("race", result.ReadOnly);
        Assert.Empty(result.Applied);
        Assert.Empty(result.NotFound);
    }

    [Fact]
    public async Task SaveAsync_UnknownField_AppearsInNotFound()
    {
        var (pluginPath, npcKey) = BuildFixture();
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var change = MakeChange(npcKey, "nonexistent_field", "\"value\"");

        var result = await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        Assert.Contains("nonexistent_field", result.NotFound);
        Assert.Empty(result.Applied);
        Assert.Empty(result.ReadOnly);
    }

    // --- IsReadOnly ---

    [Fact]
    public void IsReadOnly_FormLinkField_ReturnsTrue()
    {
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "npc_", "race"));
    }

    [Fact]
    public void IsReadOnly_BoolField_ReturnsFalse()
    {
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "npc_", "aggro_radius_behavior_enabled"));
    }

    [Fact]
    public void IsReadOnly_UnknownRecordType_ReturnsTrue()
    {
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "nonexistent_type", "some_field"));
    }

    [Fact]
    public void IsReadOnly_UnknownField_ReturnsTrue()
    {
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "npc_", "nonexistent_field"));
    }

    // --- FormKey validation: malformed FormKey string goes to notFound (mutants 125, 126) ---

    [Fact]
    public async Task SaveAsync_MalformedFormKey_FieldAppearsInNotFound()
    {
        var (pluginPath, _) = BuildFixture();
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var change = MakeChangeRaw("INVALID", "aggression", "\"Frenzied\"");

        var result = await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        Assert.Contains("aggression", result.NotFound);
        Assert.Empty(result.Applied);
        Assert.Empty(result.ReadOnly);
    }

    // --- Valid FormKey not in mod goes to notFound (mutants 127, 131, 132) ---

    [Fact]
    public async Task SaveAsync_FormKeyNotInMod_FieldAppearsInNotFound()
    {
        var (pluginPath, _) = BuildFixture();
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        // FormKey is valid but this NPC doesn't exist in the plugin
        var absentKey = FormKey.Factory("FFFFFF:TestPlugin.esp");
        var change = MakeChange(absentKey, "aggression", "\"Frenzied\"");

        var result = await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        Assert.Contains("aggression", result.NotFound);
        Assert.Empty(result.Applied);
        Assert.Empty(result.ReadOnly);
    }

    // --- CreateBackup throws IOException when backup already exists (mutant 156) ---

    [Fact]
    public void CreateBackup_FileAlreadyExists_ThrowsIOException()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"pw-backup-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var pluginPath = Path.Combine(dir, "TestPlugin.esp");
            File.WriteAllText(pluginPath, "dummy");

            var ts = "2020-01-01T00-00-00";
            // First call succeeds
            PluginWriter.CreateBackup(pluginPath, ts);

            // Second call with same timestamp must throw, not silently overwrite
            Assert.Throws<IOException>(() => PluginWriter.CreateBackup(pluginPath, ts));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // --- PruneOldBackups deletes oldest files, keeps newest MaxBackups (mutants 138, 159, 160, 162) ---

    [Fact]
    public void PruneOldBackups_ExcessBackups_DeletesOldestKeepsNewest()
    {
        const int MaxBackups = 5;
        var dir = Path.Combine(Path.GetTempPath(), $"pw-prune-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var pluginPath = Path.Combine(dir, "TestPlugin.esp");
            File.WriteAllText(pluginPath, "dummy");

            // Create MaxBackups + 2 backup files with known ascending timestamps
            var timestamps = new[]
            {
                "2020-01-01T00-00-01",
                "2020-01-01T00-00-02",
                "2020-01-01T00-00-03",
                "2020-01-01T00-00-04",
                "2020-01-01T00-00-05",
                "2020-01-01T00-00-06",
                "2020-01-01T00-00-07",
            };

            var createdPaths = timestamps
                .Select(ts => PluginWriter.CreateBackup(pluginPath, ts))
                .ToList();

            var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
            writer.PruneOldBackups(pluginPath);

            // Newest MaxBackups should survive; oldest 2 should be deleted
            var surviving = Directory.GetFiles(dir, "TestPlugin.*.bak.esp");
            Assert.Equal(MaxBackups, surviving.Length);

            // The two oldest (timestamps[0] and timestamps[1]) must be gone
            Assert.False(File.Exists(createdPaths[0]), "Oldest backup should be deleted");
            Assert.False(File.Exists(createdPaths[1]), "Second oldest backup should be deleted");

            // The newest MaxBackups must still exist
            for (int i = 2; i < timestamps.Length; i++)
                Assert.True(File.Exists(createdPaths[i]), $"Backup {i} should survive");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // --- PruneOldBackups is called after save (mutant 138 via SaveAsync integration) ---

    [Fact]
    public async Task SaveAsync_WithExcessBackups_PrunesAfterSave()
    {
        var (pluginPath, npcKey) = BuildFixture();
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);

        // Pre-create MaxBackups + 1 backups (SaveAsync will add one more → MaxBackups + 2 total before prune)
        for (int i = 1; i <= 6; i++)
        {
            var ts = $"2020-01-0{i}T00-00-00";
            PluginWriter.CreateBackup(pluginPath, ts);
        }

        var change = MakeChange(npcKey, "aggression", "\"Frenzied\"");
        await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        // After save + prune, backup count must not exceed MaxBackups
        var backups = Directory.GetFiles(dir, $"{name}.*.bak.esp");
        Assert.True(backups.Length <= 5, $"Expected at most 5 backups after prune, got {backups.Length}");
    }
}
