using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Starfield;
using static MEditService.Codec.Tests.TestSupport.DocumentEditing;

namespace MEditService.Codec.Tests.Schema;

public sealed class StarfieldConditionDocumentTests
{
    private readonly LoadScreen _screen;

    public StarfieldConditionDocumentTests()
    {
        var mod = new StarfieldMod(ModKey.FromFileName("StarfieldEdit.esp"), StarfieldRelease.Starfield);
        _screen = mod.LoadScreens.AddNew("Screen");
        _screen.Conditions.Add(new ConditionFloat
        {
            Data = new GetVATSValueConditionData { FirstParameter = 3, SecondParameter = 5, FirstUnusedStringParameter = "stale" },
        });
    }

    private string EditedData(string member, string value) =>
        Edited(GameRelease.Starfield, RecordTextCodec.SerializeToText(_screen, GameRelease.Starfield), "lscr", EditOp.Set, value,
            Member("Conditions"), At(0), Member("Data"), Member(member));

    private static JsonObject Data(string text) =>
        JsonNode.Parse(text).Require()["Conditions"].Require()[0].Require()["Data"].Require().AsObject();

    [Fact]
    public void AChangeOfFunction_EmptiesTheIntegerParametersTheNewFunctionLeavesUnused()
    {
        var before = RecordTextCodec.SerializeToText(_screen, GameRelease.Starfield);

        var after = EditedData("MutagenObjectType", $"\"{nameof(GetWantBlockingConditionData)}\"");

        Assert.Equal(
            [
                $"Conditions[0].Data.MutagenObjectType: \"{nameof(GetVATSValueConditionData)}\" -> \"{nameof(GetWantBlockingConditionData)}\"",
                "Conditions[0].Data.FirstParameter: 3 -> <absent>",
                "Conditions[0].Data.FirstUnusedStringParameter: \"stale\" -> <absent>",
                "Conditions[0].Data.SecondParameter: 5 -> <absent>",
            ],
            DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void AChangeOfFunction_KeepsTheIntegerParametersBothFunctionsRead()
    {
        var data = Data(EditedData("MutagenObjectType", $"\"{nameof(GetPlayerControlsDisabledConditionData)}\""));

        Assert.Equal([3, 5], [data["FirstParameter"].Require().GetValue<int>(), data["SecondParameter"].Require().GetValue<int>()]);
    }
}
