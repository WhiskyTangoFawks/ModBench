using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Skyrim;
using static MEditService.Codec.Tests.TestSupport.DocumentEditing;

namespace MEditService.Codec.Tests.Schema;

public sealed class SkyrimConditionDocumentTests
{
    private readonly SkyrimMod _mod = new(ModKey.FromFileName("SkyrimEdit.esp"), SkyrimRelease.SkyrimSE);
    private readonly Npc _npc;
    private readonly Perk _perk;

    public SkyrimConditionDocumentTests()
    {
        _npc = _mod.Npcs.AddNew("Guy");
        _perk = _mod.Perks.AddNew("Perk");
        _perk.Conditions.Add(new ConditionFloat
        {
            Data = new GetActorValueConditionData
            {
                ActorValue = ActorValue.Health,
                FirstUnusedStringParameter = "stale",
                SecondUnusedIntParameter = 7,
            },
        });
        var onReference = new GetIsSexConditionData { RunOnType = Condition.RunOnType.Reference };
        onReference.Reference.SetTo(_npc.FormKey);
        _perk.Conditions.Add(new ConditionFloat { Data = onReference });
        var toLink = new GetDistanceConditionData();
        toLink.Target.Link.SetTo(_npc.FormKey);
        _perk.Conditions.Add(new ConditionFloat { Data = toLink });
        var toAlias = new GetDistanceConditionData { UseAliases = true };
        toAlias.Target.Index = 3;
        _perk.Conditions.Add(new ConditionFloat { Data = toAlias });
    }

    private string PerkText() => RecordTextCodec.SerializeToText(_perk, GameRelease.SkyrimSE);

    private static string EditedData(string before, int condition, string member, string value) =>
        Edited(GameRelease.SkyrimSE, before, "perk", EditOp.Set, value, Member("Conditions"), At(condition), Member("Data"), Member(member));

    private static JsonObject Data(string text, int condition) =>
        JsonNode.Parse(text).Require()["Conditions"].Require()[condition].Require()["Data"].Require().AsObject();

    [Fact]
    public void AChangeOfFunction_EmptiesTheParametersTheNewFunctionLeavesUnused()
    {
        var before = PerkText();
        Assert.Equal("stale", Data(before, 0)["FirstUnusedStringParameter"].Require().GetValue<string>());

        var after = EditedData(before, 0, "MutagenObjectType", $"\"{nameof(GetCurrentTimeConditionData)}\"");

        Assert.Equal(
            [
                $"Conditions[0].Data.MutagenObjectType: \"{nameof(GetActorValueConditionData)}\" -> \"{nameof(GetCurrentTimeConditionData)}\"",
                "Conditions[0].Data.ActorValue: \"Health\" -> <absent>",
                "Conditions[0].Data.FirstUnusedStringParameter: \"stale\" -> <absent>",
                "Conditions[0].Data.SecondUnusedIntParameter: 7 -> <absent>",
            ],
            DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void AChangeOfFunction_KeepsAParameterBothFunctionsUse()
    {
        var after = EditedData(PerkText(), 0, "MutagenObjectType", $"\"{nameof(GetBaseActorValueConditionData)}\"");

        Assert.Equal("Health", Data(after, 0)["ActorValue"].Require().GetValue<string>());
    }

    [Fact]
    public void AChangeOfRunOn_LeavingReference_EmptiesTheReference()
    {
        var before = PerkText();

        var after = EditedData(before, 1, "RunOnType", "\"Subject\"");

        Assert.Equal(
            [
                "Conditions[1].Data.RunOnType: \"Reference\" -> <absent>",
                $"Conditions[1].Data.Reference: \"{_npc.FormKey}\" -> <absent>",
            ],
            DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void AFormParameterHeldAsALink_IsAReference_AndOneHeldAsAnIndexIsNone()
    {
        var references = FormReferences.Collect(PerkText(), SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["perk"].RecordColumns);

        Assert.Contains(new FormReference(_npc.FormKey.ToString(), "Conditions[2].Data.Target"), references);
        Assert.DoesNotContain(references, r => r.FieldPath == "Conditions[3].Data.Target");
    }

    [Fact]
    public void AFormParameterHeldAsAnIndex_TakesANumber()
    {
        var after = EditedData(PerkText(), 3, "Target", "5");

        Assert.Equal(5, Data(after, 3)["Target"].Require().GetValue<int>());
    }

    [Theory]
    [InlineData(2, "UseAliases", "true")]
    [InlineData(2, "UsePackageData", "true")]
    [InlineData(3, "UseAliases", "null")]
    public void AChangeOfWhatAFormParameterNames_EmptiesIt(int condition, string flag, string value)
    {
        Assert.Null(DocumentEdit.Locate(
            Document.Parse(PerkText()), SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["perk"], EditOp.Set,
            [Member("Conditions"), At(condition), Member("Data"), Member(flag)], out var edit));
        Assert.Null(edit.Require().Apply(value, out var patch));

        var data = Data(patch.Require().Document.Text, condition);

        Assert.False(data.ContainsKey("Target"));
        Assert.Equal(value, data[flag]?.ToJsonString() ?? "null");
    }
}
