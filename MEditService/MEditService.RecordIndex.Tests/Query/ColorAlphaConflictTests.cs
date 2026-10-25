using System.Drawing;
using System.Text.Json.Nodes;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ColorAlphaConflictTests
{
    private static readonly Color Rgb102030 = Color.FromArgb(0, 0x10, 0x20, 0x30);

    private static Action<Weather> Lightning(Color color) => weather => weather.LightningColor = color;

    private static Action<Keyword> Tint(Color color) => keyword => keyword.Color = color;

    private static ConflictThis OverrideState(CompareResult result, string member) =>
        result.Diffs.Single(d => d.FieldName == member).CellStates["B.esp"];

    private static readonly Dictionary<string, (Func<CompareResult> Compared, string Member, ConflictThis State)> Colors = new()
    {
        ["a color holding no alpha, whose document spells it without one, is identical to its master"] = (
            () => ComparedCopies.Spelled("B.esp", document => document["LightningColor"] = "#102030", Lightning(Rgb102030), Lightning(Rgb102030)),
            "LightningColor", ConflictThis.IdenticalToMaster),
        ["a color holding no alpha, whose document spells one, is identical to its master"] = (
            () => ComparedCopies.Spelled("B.esp", document => document["LightningColor"] = "#7F102030", Lightning(Rgb102030), Lightning(Rgb102030)),
            "LightningColor", ConflictThis.IdenticalToMaster),
        ["a color holding no alpha, absent against its default's rgb spelled without alpha, is identical to its master"] = (
            () => ComparedCopies.Spelled<Weather>("B.esp", document => document["LightningColor"] = "#000000", _ => { }, _ => { }),
            "LightningColor", ConflictThis.IdenticalToMaster),
        ["a color holding no alpha that differs in its rgb overrides"] = (
            () => ComparedCopies.Of(Lightning(Rgb102030), Lightning(Color.FromArgb(0, 0x10, 0x20, 0x31))),
            "LightningColor", ConflictThis.Override),
        ["a color holding alpha that differs in its alpha overrides"] = (
            () => ComparedCopies.Of(Tint(Rgb102030), Tint(Color.FromArgb(0x7F, Rgb102030))),
            "Color", ConflictThis.Override),
        ["a color holding alpha, spelled with and without an opaque alpha, is identical to its master"] = (
            () => ComparedCopies.Spelled("B.esp", document => document["Color"] = "#102030", Tint(Color.FromArgb(0xFF, Rgb102030)), Tint(Color.FromArgb(0xFF, Rgb102030))),
            "Color", ConflictThis.IdenticalToMaster),
    };

    public static TheoryData<string> ColorRules => [.. Colors.Keys];

    [Theory]
    [MemberData(nameof(ColorRules))]
    public void AColorsCopies_ConflictOnlyInWhatTheColorHolds(string rule)
    {
        var (compared, member, state) = Colors[rule];

        Assert.Equal(state, OverrideState(compared(), member));
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

        var result = index.Queries.GetCompare(placed.ToString(), new CopyText(edited, document.ToJsonString())).Value()
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
