using System.Globalization;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// The header-write half of the Partial Form work: the one sanctioned write to header
/// flag bit 14 — clearing it restores full editability, the write touches only that bit,
/// and no other write surface can flip the same bit as a side effect.
/// </summary>
public sealed class PartialFormHeaderWriteTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    // An extra, unrelated bit riding alongside PartialFormBit on the fixture cell — the rival
    // (a full-overwrite Set) clobbers this the moment it's exercised, so its presence is what makes
    // the byte-diff assertion a real test rather than one that would pass by coincidence on a cell
    // that carried no other flag at all.
    private const int PersistentBit = 0x0000_0400;
    private const string PluginName = "PartialFormHeaderWrite.esp";
    private const string Origin = "PartialFormHeaderWriteMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-partialform-header-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-partialform-header-game-").FullName;
    private readonly LoadOrderMirror _mirror;

    public PluginKey Plugin { get; } = new(PluginName, Origin);
    public FormKey PartialCell { get; }
    public FormKey OrdinaryNpc { get; }

    public PartialFormHeaderWriteTests()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var cell = new Cell(mod)
        {
            EditorID = "PartialCell",
            WaterHeight = 100f,
            MajorRecordFlagsRaw = PartialFormBit | PersistentBit,
        };
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        var npc = mod.Npcs.AddNew("OrdinaryNpc");

        mod.WriteToBinary(pluginPath);
        PartialCell = cell.FormKey;
        OrdinaryNpc = npc.FormKey;

        _mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)_mirror).Reconcile(
            _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _mirror.Dispose();
        try { Directory.Delete(_modFolder, recursive: true); } catch { /* best-effort cleanup */ }
        try { Directory.Delete(_gameDirectory, recursive: true); } catch { /* best-effort cleanup */ }
    }

    private RecordEditService Service() =>
        new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    // Refusal on a body field while flagged, success clearing the flag, success on the
    // previously-refused field once cleared. xEdit's own SetIsPartialForm
    // (wbImplementation.pas:14146-14221) re-populates a cleared override from its nearest
    // non-partial predecessor; mEdit's minimum, stated in CONTEXT.md's own Partial Form entry, is
    // narrower — the record becomes writable again, which is what this pins.
    [Fact]
    public void EditField_ClearingPartialForm_RestoresFullEditability()
    {
        var service = Service();

        var beforeClear = service.EditField(Plugin, PartialCell.ToString(), "water_height", Json("50.0"));
        Assert.False(beforeClear.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFieldReadOnly, beforeClear.Refusal);

        var clear = service.EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false"));
        Assert.True(clear.Applied);

        var afterClear = service.EditField(Plugin, PartialCell.ToString(), "water_height", Json("50.0"));
        Assert.True(afterClear.Applied);
    }

    [Fact]
    public void EditField_SettingIsPartialForm_OnEligibleUnflaggedRecord_Succeeds()
    {
        var service = Service();
        // OrdinaryNpc isn't eligible; use a fresh, unflagged Cell-shaped fixture instead by clearing
        // the seeded flag first, then setting it again — proves the write is a genuine toggle, not
        // just a one-way clear.
        Assert.True(service.EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false")).Applied);

        var result = service.EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("true"));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_IsPartialForm_OnNonPartialFormableType_IsRefused()
    {
        var result = Service().EditField(Plugin, OrdinaryNpc.ToString(), "is_partial_form", Json("true"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }

    // The write flips only header-flag bit 14 — a byte-diff over the record's own source file,
    // not just an in-memory assertion, so a codec-level bug (e.g. reserializing more than the one
    // changed property) would also be caught.
    [Fact]
    public void EditField_ClearingIsPartialForm_ChangesOnlyBit14InSourceFile()
    {
        var path = SourcePath();
        var before = File.ReadAllText(path);

        var result = Service().EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false"));
        Assert.True(result.Applied);

        var after = File.ReadAllText(path);
        AssertOnlyBit14Changed(before, after, PartialFormBit | PersistentBit, PersistentBit);
    }

    [Fact]
    public void EditField_SettingIsPartialForm_ChangesOnlyBit14InSourceFile()
    {
        // Start from a cleared cell so this test exercises the opposite direction from the one above.
        Assert.True(Service().EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false")).Applied);
        var path = SourcePath();
        var before = File.ReadAllText(path);

        var result = Service().EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("true"));
        Assert.True(result.Applied);

        var after = File.ReadAllText(path);
        AssertOnlyBit14Changed(before, after, PersistentBit, PersistentBit | PartialFormBit);
    }

    /// <summary>
    /// Structured JSON diff between the record's own source text before/after a header-flag edit —
    /// <c>MajorRecordFlagsRaw</c> must differ by exactly bit 14, and every OTHER property must be
    /// byte-identical. Two properties are deliberately excluded from that "every other property"
    /// sweep: <c>Fallout4MajorRecordFlags</c> and <c>MajorFlags</c> are not independently stored —
    /// Mutagen serializes them as pure re-renderings of the very same <c>MajorRecordFlagsRaw</c> int
    /// (confirmed by inspection: editing <c>is_partial_form</c> alone changes all three in the source
    /// file), so their changing in lockstep is the one fact moving, not a second one. Everything else
    /// on the record — <c>EditorID</c>, <c>WaterHeight</c>, and any other field a wider fixture
    /// carried — must come back unchanged, which is the substance of "no other field moves".
    /// </summary>
    private static void AssertOnlyBit14Changed(string beforeJson, string afterJson, int expectedBefore, int expectedAfter)
    {
        Assert.Equal(PartialFormBit, expectedBefore ^ expectedAfter);

        using var beforeDoc = System.Text.Json.JsonDocument.Parse(beforeJson);
        using var afterDoc = System.Text.Json.JsonDocument.Parse(afterJson);
        var before = beforeDoc.RootElement;
        var after = afterDoc.RootElement;

        Assert.Equal(expectedBefore, before.GetProperty("MajorRecordFlagsRaw").GetInt32());
        Assert.Equal(expectedAfter, after.GetProperty("MajorRecordFlagsRaw").GetInt32());

        var mirroredOfMajorRecordFlagsRaw = new HashSet<string>(StringComparer.Ordinal)
        {
            "MajorRecordFlagsRaw", "Fallout4MajorRecordFlags", "MajorFlags",
        };
        var beforeOthers = before.EnumerateObject()
            .Where(p => !mirroredOfMajorRecordFlagsRaw.Contains(p.Name))
            .ToDictionary(p => p.Name, p => p.Value.GetRawText());
        var afterOthers = after.EnumerateObject()
            .Where(p => !mirroredOfMajorRecordFlagsRaw.Contains(p.Name))
            .ToDictionary(p => p.Name, p => p.Value.GetRawText());
        Assert.Equal(beforeOthers, afterOthers);
    }

    // Two reflected columns alias the same MajorRecordFlagsRaw int bit 14 lives in.
    // is_partial_form is the one sanctioned door — a generic write that would flip bit 14 as a side
    // effect is refused, and nothing lands on disk. Both exercised starting from an UNFLAGGED
    // record, deliberately: the PartialFormFieldReadOnly guard already blocks every
    // non-exempt field (these two columns included) whenever the flag IS currently set, so that
    // shape reaches that guard, not this one — the second door is live precisely when the record
    // is unflagged, which is what these fixtures set up.
    [Fact]
    public void EditField_MajorFlags_AttemptingToSetBit14OnUnflaggedRecord_IsRefused()
    {
        Assert.True(Service().EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false")).Applied);
        var path = SourcePath();
        var before = File.ReadAllText(path);

        // major_flags is Cell.MajorFlags's own reflected bitmask column — a plain decimal BIGINT
        // that replaces MajorRecordFlagsRaw wholesale (SchemaReflector.ReadBitmaskLong /
        // Enum.ToObject), so writing PersistentBit | PartialFormBit sets bit 14 as a side effect.
        var result = Service().EditField(
            Plugin, PartialCell.ToString(), "major_flags",
            Json((PersistentBit | PartialFormBit).ToString(CultureInfo.InvariantCulture)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFlagIndirectWrite, result.Refusal);
        Assert.Equal(before, File.ReadAllText(path));
    }

    [Fact]
    public void EditField_FallOut4MajorRecordFlags_AttemptingToSetBit14OnUnflaggedRecord_IsRefused()
    {
        Assert.True(Service().EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false")).Applied);
        var path = SourcePath();
        var before = File.ReadAllText(path);

        var result = Service().EditField(
            Plugin, PartialCell.ToString(), "fallout4_major_record_flags", Json(PartialFormBit.ToString(CultureInfo.InvariantCulture)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFlagIndirectWrite, result.Refusal);
        Assert.Equal(before, File.ReadAllText(path));
    }

    // The guard is bit-14-specific, not a blanket lockout of these two columns — a write through
    // either that leaves bit 14 untouched still succeeds. Also starts unflagged, for the same reason
    // as the two tests above: while flagged, the pre-existing PartialFormFieldReadOnly guard refuses
    // every non-exempt field regardless of which bits it touches, so this column would never reach
    // this guard's own bit-14 comparison at all — the case worth pinning is the one where it does.
    [Fact]
    public void EditField_MajorFlags_NotTouchingBit14_Succeeds()
    {
        Assert.True(Service().EditField(Plugin, PartialCell.ToString(), "is_partial_form", Json("false")).Applied);

        var result = Service().EditField(
            Plugin, PartialCell.ToString(), "major_flags", Json(PersistentBit.ToString(CultureInfo.InvariantCulture)));

        Assert.True(result.Applied);
    }

    private string SourcePath() =>
        Directory.EnumerateFiles(_modFolder, "RecordData.json", SearchOption.AllDirectories)
            .Single(p => p.Contains("PartialCell", StringComparison.Ordinal));

    private static System.Text.Json.JsonElement Json(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
}
