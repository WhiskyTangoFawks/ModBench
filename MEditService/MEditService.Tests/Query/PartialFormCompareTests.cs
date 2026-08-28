using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

/// <summary>
/// #491 AC1: a master Cell + a later plugin's Partial Form override of it, carrying one REFR child.
/// The override's own fields (even ones that genuinely differ from the master, not merely absent
/// ones — CONTEXT.md's Partial Form entry: "its own fields are ignored... full stop") must not
/// register as a conflict; the REFR is a separate record and is unaffected.
/// </summary>
public sealed class PartialFormCompareTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    private const float MasterWaterHeight = 100f;
    // Deliberately different from the master's own value — proves the override's field is excluded
    // from conflict detection because it is Partial Form, not merely because the values happen to
    // agree.
    private const float OverrideOwnWaterHeight = 999f;

    private readonly PluginFixtureData _fixture;
    private readonly SessionManager _manager;
    private readonly RecordQueryService _service;

    public static readonly FormKey CellKey = new(ModKey.FromFileName("Base.esm"), 0x800);

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    public FormKey RefKey { get; }

    public PartialFormCompareTests()
    {
        FormKey refKey = default;

        _fixture = new PluginFixtureBuilder("partial-form-compare")
            .WithPlugin("Base.esm", mod =>
            {
                var cell = new Cell(mod) { EditorID = "TestCell", WaterHeight = MasterWaterHeight };
                AddInteriorCell(mod, cell);
            })
            .WithPlugin("Partial.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                var cell = basePlugin.Cells.Records
                    .SelectMany(b => b.SubBlocks).SelectMany(sb => sb.Cells)
                    .First(c => c.FormKey == CellKey)
                    .DeepCopy();
                cell.MajorRecordFlagsRaw |= PartialFormBit;
                // A real, non-null difference — not merely an absent field — to prove exclusion
                // rather than coincidental agreement.
                cell.WaterHeight = OverrideOwnWaterHeight;

                var refr = new PlacedObject(mod) { EditorID = "TestRef", Scale = 1f };
                cell.Temporary.Add(refr);
                refKey = refr.FormKey;

                AddInteriorCell(mod, cell);
            })
            .Build();

        RefKey = refKey;

        var reflector = SharedSchemaReflector.Instance;
        _manager = new SessionManager(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        _manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        _service = new RecordQueryService(_manager, reflector, new ConflictClassifier());
    }

    public void Dispose()
    {
        _manager.Dispose();
        _fixture.Dispose();
    }

    // ── Slice 2: IsPartialForm threads through the read model ──────────────────────────────

    [Fact]
    public void GetCompare_MasterOverride_IsPartialFormFalse()
    {
        var compare = _service.GetCompare(CellKey.ToString())!;
        var master = compare.Overrides.Single(o => o.Plugin == "Base.esm");

        Assert.False(master.IsPartialForm);
    }

    [Fact]
    public void GetCompare_PartialFormOverride_IsPartialFormTrue()
    {
        var compare = _service.GetCompare(CellKey.ToString())!;
        var partial = compare.Overrides.Single(o => o.Plugin == "Partial.esp");

        Assert.True(partial.IsPartialForm);
    }

    // ── AC1: cell shows no conflict; REFR shows normally ────────────────────────────────────

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_ShowsNoConflict()
    {
        var compare = _service.GetCompare(CellKey.ToString())!;

        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_WaterHeightDiffCarriesNoCellStateForTheOverride()
    {
        var compare = _service.GetCompare(CellKey.ToString())!;
        var waterHeight = compare.Diffs.Single(d => d.FieldName == "water_height");

        Assert.Equal(ConflictAll.NoConflict, waterHeight.ConflictAll);
        Assert.DoesNotContain("Partial.esp", waterHeight.CellStates.Keys);
    }

    // ── Slice 4: per-field WinnerColumn/WinnerValue fall through past a Partial Form override ──

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_WaterHeightWinnerFallsThroughToMaster()
    {
        // The record-wide winner (last in load order) is Partial.esp, but its own water_height is
        // excluded — the field's real effective value is the master's, and WinnerColumn/WinnerValue
        // must say so rather than pointing at a column whose contribution was just excluded.
        var compare = _service.GetCompare(CellKey.ToString())!;
        var waterHeight = compare.Diffs.Single(d => d.FieldName == "water_height");

        Assert.Equal("Base.esm", waterHeight.WinnerColumn);
        Assert.NotNull(waterHeight.WinnerValue);
        Assert.Equal(MasterWaterHeight, Convert.ToSingle(waterHeight.WinnerValue, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void GetRecord_RefIntroducedByPartialFormOverride_ShowsNormally()
    {
        var compare = _service.GetCompare(RefKey.ToString())!;

        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.Single(compare.Overrides);
        Assert.Equal("Partial.esp", compare.Overrides[0].Plugin);
    }
}
