using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using static MEditService.Codec.Tests.TestSupport.DocumentEditing;
using SkyrimRecords = Mutagen.Bethesda.Skyrim;
using StarfieldRecords = Mutagen.Bethesda.Starfield;

namespace MEditService.Codec.Tests.Schema;

public sealed class FunctionLeafConditionDocumentTests
{
    private static readonly SkyrimRecords.SkyrimMod SkyrimMod = new(ModKey.FromFileName("SkyrimEdit.esp"), SkyrimRecords.SkyrimRelease.SkyrimSE);

    private static readonly SkyrimRecords.Npc SkyrimNpc = SkyrimMod.Npcs.AddNew("Guy");

    private static string SkyrimPerkText()
    {
        var perk = new SkyrimRecords.Perk(new FormKey(SkyrimMod.ModKey, 0x900), SkyrimRecords.SkyrimRelease.SkyrimSE) { EditorID = "Perk" };
        perk.Conditions.Add(new SkyrimRecords.ConditionFloat
        {
            Data = new SkyrimRecords.GetActorValueConditionData
            {
                ActorValue = SkyrimRecords.ActorValue.Health,
                FirstUnusedStringParameter = "stale",
                SecondUnusedIntParameter = 7,
            },
        });
        var toLink = new SkyrimRecords.GetDistanceConditionData();
        toLink.Target.Link.SetTo(SkyrimNpc.FormKey);
        perk.Conditions.Add(new SkyrimRecords.ConditionFloat { Data = toLink });
        var toAlias = new SkyrimRecords.GetDistanceConditionData { UseAliases = true };
        toAlias.Target.Index = 3;
        perk.Conditions.Add(new SkyrimRecords.ConditionFloat { Data = toAlias });
        return RecordTextCodec.SerializeToText(perk, GameRelease.SkyrimSE);
    }

    private static string StarfieldLoadScreenText()
    {
        var screen = new StarfieldRecords.LoadScreen(new FormKey(ModKey.FromFileName("StarfieldEdit.esp"), 0x800), StarfieldRecords.StarfieldRelease.Starfield) { EditorID = "Screen" };
        screen.Conditions.Add(new StarfieldRecords.ConditionFloat
        {
            Data = new StarfieldRecords.GetVATSValueConditionData { FirstParameter = 3, SecondParameter = 5, FirstUnusedStringParameter = "stale" },
        });
        return RecordTextCodec.SerializeToText(screen, GameRelease.Starfield);
    }

    private static readonly Dictionary<string, (GameRelease Release, string Table, Func<string> Text, string Leaf)> FunctionChanges = new(StringComparer.Ordinal)
    {
        ["Skyrim's GetActorValue to GetCurrentTime"] = (GameRelease.SkyrimSE, "perk", SkyrimPerkText, nameof(SkyrimRecords.GetCurrentTimeConditionData)),
        ["Skyrim's GetActorValue to GetBaseActorValue"] = (GameRelease.SkyrimSE, "perk", SkyrimPerkText, nameof(SkyrimRecords.GetBaseActorValueConditionData)),
        ["Starfield's GetVATSValue to GetWantBlocking"] = (GameRelease.Starfield, "lscr", StarfieldLoadScreenText, nameof(StarfieldRecords.GetWantBlockingConditionData)),
        ["Starfield's GetVATSValue to GetPlayerControlsDisabled"] = (GameRelease.Starfield, "lscr", StarfieldLoadScreenText, nameof(StarfieldRecords.GetPlayerControlsDisabledConditionData)),
    };

    private static (string Before, string After) ChangedFunction(string change)
    {
        var (release, table, text, leaf) = FunctionChanges[change];
        var before = text();
        return (before, Edited(release, before, table, EditOp.Set, $"\"{leaf}\"", Member("Conditions"), At(0), Member("Data"), Member("MutagenObjectType")));
    }

    [Theory]
    [InlineData(
        "Skyrim's GetActorValue to GetCurrentTime",
        new[]
        {
            "Conditions[0].Data.MutagenObjectType: \"GetActorValueConditionData\" -> \"GetCurrentTimeConditionData\"",
            "Conditions[0].Data.ActorValue: \"Health\" -> <absent>",
            "Conditions[0].Data.FirstUnusedStringParameter: \"stale\" -> <absent>",
            "Conditions[0].Data.SecondUnusedIntParameter: 7 -> <absent>",
        })]
    [InlineData(
        "Starfield's GetVATSValue to GetWantBlocking",
        new[]
        {
            "Conditions[0].Data.MutagenObjectType: \"GetVATSValueConditionData\" -> \"GetWantBlockingConditionData\"",
            "Conditions[0].Data.FirstParameter: 3 -> <absent>",
            "Conditions[0].Data.FirstUnusedStringParameter: \"stale\" -> <absent>",
            "Conditions[0].Data.SecondParameter: 5 -> <absent>",
        })]
    public void AChangeOfFunction_EmptiesTheParametersTheNewFunctionLeavesUnused(string change, string[] diffs)
    {
        var (before, after) = ChangedFunction(change);

        Assert.Equal(diffs, DocumentDiffs.Of(before, after));
    }

    [Theory]
    [InlineData("Skyrim's GetActorValue to GetBaseActorValue", "ActorValue", "\"Health\"")]
    [InlineData("Starfield's GetVATSValue to GetPlayerControlsDisabled", "FirstParameter", "3")]
    [InlineData("Starfield's GetVATSValue to GetPlayerControlsDisabled", "SecondParameter", "5")]
    public void AChangeOfFunction_KeepsAParameterBothFunctionsUse(string change, string parameter, string value)
    {
        Assert.Equal(value, Data(ChangedFunction(change).After, 0)[parameter].Require().ToJsonString());
    }

    private static JsonObject Data(string text, int condition) =>
        JsonNode.Parse(text).Require()["Conditions"].Require()[condition].Require()["Data"].Require().AsObject();

    [Fact]
    public void AFormParameterHeldAsALink_IsAReference_AndOneHeldAsAnIndexIsNone()
    {
        var references = FormReferences.Collect(SkyrimPerkText(), SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["perk"].RecordColumns);

        Assert.Contains(new FormReference(SkyrimNpc.FormKey.ToString(), "Conditions[1].Data.Target"), references);
        Assert.DoesNotContain(references, r => r.FieldPath == "Conditions[2].Data.Target");
    }

    [Theory]
    [InlineData("UseAliases")]
    [InlineData("UsePackageData")]
    public void SettingWhatAFormParameterNames_EmptiesItsLink(string flag)
    {
        var data = PatchedData(1, flag, "true");

        Assert.False(data.ContainsKey("Target"));
        Assert.True(data[flag].Require().GetValue<bool>());
    }

    [Fact]
    public void ClearingWhatAFormParameterNames_EmptiesItsIndex()
    {
        var data = PatchedData(2, "UseAliases", "null");

        Assert.False(data.ContainsKey("Target"));
        Assert.False(data.ContainsKey("UseAliases"));
    }

    private static JsonObject PatchedData(int condition, string member, string value) =>
        Data(Edited(GameRelease.SkyrimSE, SkyrimPerkText(), "perk", EditOp.Set, value, Member("Conditions"), At(condition), Member("Data"), Member(member)), condition);
}
