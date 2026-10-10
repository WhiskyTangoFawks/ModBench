using System.Drawing;
using System.Text.Json.Nodes;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class ColorAlphaConflictTests
{
    private static readonly Color Rgb102030 = Color.FromArgb(0, 0x10, 0x20, 0x30);

    private static Action<Weather> Lightning(Color color) => weather => weather.LightningColor = color;

    private static Action<Keyword> Tint(Color color) => keyword => keyword.Color = color;

    private static ConflictThis OverrideState(CompareResult result, string member) =>
        result.Diffs.Single(d => d.FieldName == member).CellStates["B.esp"];

    [Theory]
    [InlineData("#102030")]
    [InlineData("#7F102030")]
    public void AColorHoldingNoAlpha_ThatDiffersOnlyInTheAlphaItsDocumentCarries_IsIdenticalToMaster(string edited)
    {
        var result = ComparedCopies.Spelled(
            "B.esp", document => document["LightningColor"] = edited, Lightning(Rgb102030), Lightning(Rgb102030));

        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(result, "LightningColor"));
    }

    [Fact]
    public void AColorHoldingNoAlpha_AbsentAgainstItsDefaultsRgbSpelledWithoutAlpha_IsIdenticalToMaster()
    {
        var result = ComparedCopies.Spelled<Weather>("B.esp", document => document["LightningColor"] = "#000000", _ => { }, _ => { });

        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(result, "LightningColor"));
    }

    [Fact]
    public void AColorHoldingNoAlpha_ThatDiffersInItsRgb_Overrides()
    {
        var result = ComparedCopies.Of(Lightning(Rgb102030), Lightning(Color.FromArgb(0, 0x10, 0x20, 0x31)));

        Assert.Equal(ConflictThis.Override, OverrideState(result, "LightningColor"));
    }

    [Fact]
    public void AColorHoldingAlpha_ThatDiffersInItsAlpha_Overrides()
    {
        var result = ComparedCopies.Of(Tint(Rgb102030), Tint(Color.FromArgb(0x7F, Rgb102030)));

        Assert.Equal(ConflictThis.Override, OverrideState(result, "Color"));
    }

    [Fact]
    public void AColorHoldingAlpha_SpelledWithAndWithoutAnOpaqueAlpha_IsIdenticalToMaster()
    {
        var opaque = Tint(Color.FromArgb(0xFF, Rgb102030));

        var result = ComparedCopies.Spelled("B.esp", document => document["Color"] = "#102030", opaque, opaque);

        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(result, "Color"));
    }

    [Fact]
    public void AStructHoldingAColorWithNoAlpha_ThatDiffersOnlyInThatAlpha_IsIdenticalToMaster()
    {
        var cell = ComparedCopies.InMaster(0x800);
        var placed = ComparedCopies.InMaster(0x801);
        using var fixture = new PluginFixtureBuilder("medit-primitive-color")
            .WithPlugin("A.esp", mod => mod.AddInteriorCells(CellHolding(cell, placed)))
            .WithPlugin("B.esp", mod => mod.AddInteriorCells(CellHolding(cell, placed)))
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var edited = new PluginAddress("B.esp", PluginOrigin.DataDirectory);
        var document = JsonNode.Parse(index.BodyOf(placed.ToString(), edited)) as JsonObject
            ?? throw new InvalidOperationException("Expected the placed object's document to be an object.");
        document["Primitive"] = new JsonObject { ["Color"] = "#102030" };

        var result = index.Records.GetCompare(placed.ToString(), new CopyText(edited, document.ToJsonString())).Value()
            ?? throw new InvalidOperationException("Expected the placed object to compare.");

        Assert.Equal(ConflictThis.IdenticalToMaster, OverrideState(result, "Primitive"));
    }

    private static Cell CellHolding(FormKey cell, FormKey placed)
    {
        var interior = new Cell(cell, Fallout4Release.Fallout4);
        interior.Temporary.Add(new PlacedObject(placed, Fallout4Release.Fallout4) { Primitive = new PlacedPrimitive { Color = Rgb102030 } });
        return interior;
    }
}
