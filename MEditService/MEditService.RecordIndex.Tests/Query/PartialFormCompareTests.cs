using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class PartialFormCompareTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    private const float MasterWaterHeight = 100f;
    private const float OverrideOwnWaterHeightDifferingSoTheExclusionIsPartialFormsNotAgreement = 999f;

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly FormKey _cellKey;
    private readonly FormKey _contestedCellKey;
    private readonly FormKey _refKey;

    public PartialFormCompareTests()
    {
        Cell? baseCell = null;
        Cell? contestedCell = null;
        PlacedObject? refr = null;
        _fixture = new PluginFixtureBuilder("medit-partial-form-compare")
            .WithPlugin("Base.esm", mod =>
            {
                var template = mod.LightingTemplates.AddNew("Template");
                baseCell = new Cell(mod) { EditorID = "TestCell", WaterHeight = MasterWaterHeight };
                baseCell.LightingTemplate.SetTo(template);
                contestedCell = new Cell(mod) { EditorID = "ContestedCell", WaterHeight = 1f };
                mod.AddInteriorCells(baseCell, contestedCell);
            })
            .WithPlugin("Partial.esp", mod =>
            {
                var partial = PartialCopyOf(baseCell.Require());
                refr = new PlacedObject(mod) { EditorID = "TestRef", Scale = 1f };
                partial.Temporary.Add(refr);
                mod.AddInteriorCells(partial, PartialCopyOf(contestedCell.Require()));
            })
            .WithPlugin("Top.esp", mod =>
            {
                var winner = contestedCell.Require().DeepCopy();
                winner.WaterHeight = 5f;
                mod.AddInteriorCells(winner);
            })
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_cellKey, _contestedCellKey, _refKey) = (baseCell.Require().FormKey, contestedCell.Require().FormKey, refr.Require().FormKey);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static Cell PartialCopyOf(Cell cell)
    {
        var copy = cell.DeepCopy();
        copy.MajorRecordFlagsRaw |= PartialFormBit;
        copy.WaterHeight = OverrideOwnWaterHeightDifferingSoTheExclusionIsPartialFormsNotAgreement;
        return copy;
    }

    private CompareResult Compare(FormKey record) =>
        _index.Queries.GetCompare(record.ToString()).Value() ?? throw new InvalidOperationException($"Expected {record} to compare.");

    [Theory]
    [InlineData("Base.esm", false)]
    [InlineData("Partial.esp", true)]
    public void AColumn_IsPartialForm_ExactlyWhenItsCopyCarriesThePartialFormFlag(string plugin, bool partialForm)
    {
        Assert.Equal(partialForm, Compare(_cellKey).Overrides.Single(o => o.Plugin == plugin).IsPartialForm);
    }

    [Fact]
    public void APartialFormCopysOwnField_HasNoCellStateInItsColumn_AndNoConflict()
    {
        var waterHeight = Compare(_cellKey).Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.Equal(ConflictAll.NoConflict, waterHeight.ConflictAll);
        Assert.DoesNotContain("Partial.esp", waterHeight.CellStates.Keys);
    }

    [Fact]
    public void APartialFormCopysOwnField_IsWonByTheMaster_NotByTheRecordWideWinnerTheCopyIs()
    {
        var waterHeight = Compare(_cellKey).Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.Equal("Base.esm", waterHeight.WinnerColumn);
        Assert.Equal(MasterWaterHeight, Assert.IsType<JsonElement>(waterHeight.Values["Base.esm"]).GetSingle());
    }

    [Fact]
    public void ARecordComparedWithItsPartialFormCopy_IsNoConflictOnTheCopysOwnField_ThoughItsValueDiffers()
    {
        var copies = new[] { "Base.esm", "Partial.esp" }
            .Select(plugin => new RecordCopy(_cellKey.ToString(), new PluginAddress(plugin, PluginOrigin.DataDirectory)))
            .ToList();

        var waterHeight = _index.Queries.GetCompareRecords(copies).Compared().Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.Equal(ConflictAll.NoConflict, waterHeight.ConflictAll);
    }

    [Fact]
    public void APartialFormCopysOwnField_NeitherWinsNorLoses_BetweenTheMasterAndALaterCopy()
    {
        var waterHeight = Compare(_contestedCellKey).Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.DoesNotContain("Partial.esp", waterHeight.CellStates.Keys);
        Assert.Equal(ConflictThis.Override, waterHeight.CellStates["Top.esp"]);
    }

    [Fact]
    public void APartialFormCopy_ReportsNoUnsetLinkCheckError_ForAnExclusionIsNotTheRecordSayingTheLinkIsUnset()
    {
        Assert.Null(Compare(_cellKey).Diffs.Single(d => d.FieldName == "LightingTemplate").CheckErrors);
    }

    [Fact]
    public void APartialFormCopysEditorID_TakesPartInTheComparison_AsItsOwnFieldsDoNot()
    {
        var editorId = Compare(_cellKey).Diffs.Single(d => d.FieldName == "EditorID");

        Assert.Equal(ConflictThis.IdenticalToMaster, editorId.CellStates["Partial.esp"]);
        Assert.Equal("TestCell", Assert.IsType<JsonElement>(editorId.Values["Partial.esp"]).GetString());
    }

    [Fact]
    public void ARefAPartialFormCopyIntroduces_IsItsOnlyCopy()
    {
        var compare = Compare(_refKey);

        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.Equal("Partial.esp", Assert.Single(compare.Overrides).Plugin);
    }
}
