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

    // --- SaveResult outcome tests ---

    private static PendingChange MakeChange(FormKey formKey, string fieldPath, string json) =>
        new(Guid.NewGuid(), formKey.ToString(), "TestPlugin.esp", fieldPath, "npc_",
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static PendingChange MakeChangeRaw(string rawFormKey, string fieldPath, string json) =>
        new(Guid.NewGuid(), rawFormKey, "TestPlugin.esp", fieldPath, "npc_",
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow, "field_edit", null);

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
        Assert.Matches(@"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}", result.BackupPath);
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

    [Theory]
    [InlineData("nonexistent_type", "some_field")]
    [InlineData("npc_", "nonexistent_field")]
    public void IsReadOnly_UnknownInput_ReturnsTrue(string recordType, string field)
    {
        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, recordType, field));
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
        Assert.Single(result.NotFound);  // exactly one entry — malformed key path not double-counted
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

    // --- $create changes ---

    [Fact]
    public async Task SaveAsync_CreateChange_NoTemplate_NewRecordAppearsInPlugin()
    {
        var data = new PluginFixtureBuilder("pw-create-blank")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modPath = new Mutagen.Bethesda.Plugins.ModPath(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("TestPlugin.esp"), pluginPath);

        using var existing = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var reservedId = existing.NextFormID;
        var newFormKey = Mutagen.Bethesda.Plugins.FormKey.Factory($"{reservedId:X6}:TestPlugin.esp");

        var createChange = new PendingChange(
            Guid.NewGuid(), newFormKey.ToString(), "TestPlugin.esp",
            "$create", "npc_",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", null);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [createChange], GameRelease.Fallout4);

        Assert.Contains("$create", result.Applied);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        Assert.True(saved.EnumerateMajorRecords().Any(r => r.FormKey == newFormKey),
            $"Expected record with FormKey {newFormKey} to exist after save.");
    }

    [Fact]
    public async Task SaveAsync_CreateChange_UnknownRecordType_AppearsInCreateFailed()
    {
        var data = new PluginFixtureBuilder("pw-create-unknown-type")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        var fakeFormKey = Mutagen.Bethesda.Plugins.FormKey.Factory($"000800:TestPlugin.esp");
        var createChange = new PendingChange(
            Guid.NewGuid(), fakeFormKey.ToString(), "TestPlugin.esp",
            "$create", "not_a_real_type",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", null);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [createChange], GameRelease.Fallout4);

        Assert.Contains("not_a_real_type", result.CreateFailed);
        Assert.Empty(result.Applied);
        Assert.Empty(result.NotFound);
    }

    [Fact]
    public async Task SaveAsync_CreateChange_WithTemplateFieldEdits_AppliesFieldsToNewRecord()
    {
        var data = new PluginFixtureBuilder("pw-create-template")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modPath = new Mutagen.Bethesda.Plugins.ModPath(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("TestPlugin.esp"), pluginPath);

        using var existing = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var reservedId = existing.NextFormID;
        var newFormKey = Mutagen.Bethesda.Plugins.FormKey.Factory($"{reservedId:X6}:TestPlugin.esp");

        var groupId = Guid.NewGuid();
        var createChange = new PendingChange(
            Guid.NewGuid(), newFormKey.ToString(), "TestPlugin.esp",
            "$create", "npc_",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", groupId);

        var fieldChange = new PendingChange(
            Guid.NewGuid(), newFormKey.ToString(), "TestPlugin.esp",
            "aggression", "npc_",
            J("null"), J("\"Frenzied\""),
            "user", null, DateTime.UtcNow, "field_edit", groupId);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, [createChange, fieldChange], GameRelease.Fallout4);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var npc = saved.EnumerateMajorRecords().FirstOrDefault(r => r.FormKey == newFormKey);
        Assert.NotNull(npc);
        Assert.Equal("Frenzied", (npc as Mutagen.Bethesda.Fallout4.INpcGetter)?.Aggression.ToString());
    }

    // --- $create: FormKey validation ---

    [Fact]
    public async Task SaveAsync_CreateChange_MalformedFormKey_AppearsInNotFound()
    {
        var data = new PluginFixtureBuilder("pw-create-bad-fk")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        var createChange = new PendingChange(
            Guid.NewGuid(), "NOT_A_VALID_FORMKEY", "TestPlugin.esp",
            "$create", "npc_",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", null);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [createChange], GameRelease.Fallout4);

        Assert.Contains("$create", result.NotFound);
        Assert.Empty(result.Applied);
        Assert.Empty(result.CreateFailed);
    }

    // --- $create: NextFormID tracking ---

    [Fact]
    public async Task SaveAsync_CreateChange_FormKeyIdAtOrAboveNextFormID_BumpsNextFormID()
    {
        var data = new PluginFixtureBuilder("pw-create-bump-nextid")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modPath = new Mutagen.Bethesda.Plugins.ModPath(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("TestPlugin.esp"), pluginPath);

        using var existing = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var reservedId = existing.NextFormID;
        var newFormKey = Mutagen.Bethesda.Plugins.FormKey.Factory($"{reservedId:X6}:TestPlugin.esp");

        var createChange = new PendingChange(
            Guid.NewGuid(), newFormKey.ToString(), "TestPlugin.esp",
            "$create", "npc_",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", null);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, [createChange], GameRelease.Fallout4);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        Assert.True(saved.NextFormID > reservedId,
            $"NextFormID should have been bumped above {reservedId:X6}, but was {saved.NextFormID:X6}");
    }

    [Fact]
    public async Task SaveAsync_CreateChange_FormKeyIdBelowNextFormID_NextFormIDUnchanged()
    {
        var data = new PluginFixtureBuilder("pw-create-no-bump-nextid")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modPath = new Mutagen.Bethesda.Plugins.ModPath(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("TestPlugin.esp"), pluginPath);

        using var existing = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var originalNextFormID = existing.NextFormID;

        // Use a FormKey ID strictly below the current NextFormID so the mod needs no update
        var lowId = originalNextFormID > 1 ? originalNextFormID - 1 : 1u;
        var lowFormKey = Mutagen.Bethesda.Plugins.FormKey.Factory($"{lowId:X6}:TestPlugin.esp");

        var createChange = new PendingChange(
            Guid.NewGuid(), lowFormKey.ToString(), "TestPlugin.esp",
            "$create", "npc_",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", null);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, [createChange], GameRelease.Fallout4);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        Assert.Equal(originalNextFormID, saved.NextFormID);
    }

    // --- Delete pass tests ---

    private static PendingChange MakeDeleteChange(FormKey formKey) =>
        new(Guid.NewGuid(), formKey.ToString(), "TestPlugin.esp",
            "$delete", "npc_",
            JsonDocument.Parse("null").RootElement, JsonDocument.Parse("null").RootElement,
            "user", null, DateTime.UtcNow, "delete", null);

    [Fact]
    public async Task SaveAsync_DeleteChange_RecordRemovedAndApplied()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("pw-delete")
            .WithPlugin("TestPlugin.esp", mod => npcKey = mod.Npcs.AddNew("ToDeleteNPC").FormKey)
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modKey = ModKey.FromFileName("TestPlugin.esp");
        var modPath = new ModPath(modKey, pluginPath);

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [MakeDeleteChange(npcKey)], GameRelease.Fallout4);

        Assert.Contains("$delete", result.Applied);
        Assert.Empty(result.NotFound);
        Assert.Empty(result.ReadOnly);
        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        Assert.DoesNotContain(saved.EnumerateMajorRecords(), r => r.FormKey == npcKey);
    }

    [Fact]
    public async Task SaveAsync_DeleteChange_UnknownFormKey_AppearsInNotFound()
    {
        var data = new PluginFixtureBuilder("pw-delete-notfound")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var absentKey = FormKey.Factory("FFFFFF:TestPlugin.esp");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [MakeDeleteChange(absentKey)], GameRelease.Fallout4);

        Assert.Contains("$delete", result.NotFound);
        Assert.Empty(result.Applied);
    }

    [Fact]
    public async Task SaveAsync_DeleteAndFieldEdit_BothHandledCorrectly()
    {
        FormKey npcToDelete = default;
        FormKey npcToEdit = default;
        var data = new PluginFixtureBuilder("pw-delete-and-edit")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                npcToDelete = mod.Npcs.AddNew("NPC_ToDelete").FormKey;
                npcToEdit = mod.Npcs.AddNew("NPC_ToEdit").FormKey;
            })
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var modKey = ModKey.FromFileName("TestPlugin.esp");
        var modPath = new ModPath(modKey, pluginPath);

        var deleteChange = MakeDeleteChange(npcToDelete);
        var editChange = MakeChange(npcToEdit, "aggression", "\"Frenzied\"");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [deleteChange, editChange], GameRelease.Fallout4);

        Assert.Contains("$delete", result.Applied);
        Assert.Contains("aggression", result.Applied);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        Assert.DoesNotContain(saved.EnumerateMajorRecords(), r => r.FormKey == npcToDelete);
        Assert.Contains(saved.EnumerateMajorRecords(), r => r.FormKey == npcToEdit);
    }

    // --- $renumber changes ---

    private static PendingChange MakeRenumber(FormKey oldKey, string plugin, uint newId, string recordType)
    {
        var oldStr = oldKey.ToString();
        var newStr = $"{newId:X6}:{plugin}";
        return new(
            Guid.NewGuid(), oldStr, plugin, "$renumber", recordType,
            JsonSerializer.SerializeToElement(oldStr),
            JsonSerializer.SerializeToElement(newStr),
            "user", null, DateTime.UtcNow, "renumber", null);
    }

    [Fact]
    public async Task SaveAsync_Renumber_OldFormKeyGoneNewFormKeyPresent()
    {
        FormKey kwKey = default;
        using var data = new PluginFixtureBuilder("pw-renumber")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "Source.esp");
        var modPath = new Mutagen.Bethesda.Plugins.ModPath(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("Source.esp"), pluginPath);

        const uint newId = 0x999990;
        var newFormKey = FormKey.Factory($"{newId:X6}:Source.esp");
        var change = MakeRenumber(kwKey, "Source.esp", newId, "kywd");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        Assert.Contains("$renumber", result.Applied);
        Assert.Empty(result.NotFound);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        Assert.DoesNotContain(saved.EnumerateMajorRecords(), r => r.FormKey == kwKey);
        Assert.Contains(saved.EnumerateMajorRecords(), r => r.FormKey == newFormKey);
    }

    [Fact]
    public async Task SaveAsync_Renumber_RemapLinksUpdatesIntraPluginReference()
    {
        FormKey kwKey = default;
        FormKey npcKey = default;
        using var data = new PluginFixtureBuilder("pw-renumber-remap")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew().FormKey;
                var npc = mod.Npcs.AddNew("RenumberRefNpc");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
                npcKey = npc.FormKey;
            })
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "Source.esp");
        var modPath = new Mutagen.Bethesda.Plugins.ModPath(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("Source.esp"), pluginPath);

        const uint newId = 0x999991;
        var newFormKey = FormKey.Factory($"{newId:X6}:Source.esp");
        var change = MakeRenumber(kwKey, "Source.esp", newId, "kywd");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, [change], GameRelease.Fallout4);

        using var saved = Mutagen.Bethesda.Plugins.Records.ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var npc = saved.EnumerateMajorRecords().OfType<INpcGetter>().Single(n => n.FormKey == npcKey);
        Assert.NotNull(npc.Keywords);
        Assert.Contains(npc.Keywords!, kw => kw.FormKey == newFormKey);
        Assert.DoesNotContain(npc.Keywords!, kw => kw.FormKey == kwKey);
    }
}
