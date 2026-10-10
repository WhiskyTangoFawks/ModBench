using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class ConditionEditTests : IDisposable
{
    private const string Cobj = "000801:DocEdit.esp";
    private const string Perk = "000802:DocEdit.esp";
    private const string Message = "000803:DocEdit.esp";

    private readonly DocumentEditFixture _fixture = new();

    public ConditionEditTests()
    {
        var cobj = new ConstructibleObject(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Recipe" };
        var stageDone = new FunctionConditionData { Function = Condition.Function.GetStageDone };
        stageDone.ParameterOneRecord.SetTo(KeyOf(0x804));
        cobj.Conditions.Add(new ConditionFloat
        {
            CompareOperator = CompareOperator.GreaterThan,
            ComparisonValue = 2.5f,
            Flags = Condition.Flag.OR,
            Data = stageDone,
        });
        var useGlobal = new ConditionGlobal { CompareOperator = CompareOperator.NotEqualTo, Data = new FunctionConditionData { Function = Condition.Function.GetIsSex } };
        useGlobal.ComparisonValue.SetTo(KeyOf(0x805));
        cobj.Conditions.Add(useGlobal);
        _fixture.Seed(cobj, "cobj");

        var perk = new Perk(KeyOf(0x802), Fallout4Release.Fallout4) { EditorID = "Perk" };
        var perkCondition = new PerkCondition { RunOnTabIndex = 0 };
        perkCondition.Conditions.Add(NestedCondition());
        var effect = new PerkQuestEffect { Rank = 1, Priority = 2 };
        effect.Conditions.Add(perkCondition);
        perk.Effects.Add(effect);
        _fixture.Seed(perk, "perk");

        var message = new Message(KeyOf(0x803), Fallout4Release.Fallout4) { EditorID = "Message" };
        var button = new MessageButton { Text = "Press" };
        button.Conditions.Add(NestedCondition());
        message.MenuButtons.Add(button);
        _fixture.Seed(message, "mesg");
    }

    public void Dispose() => _fixture.Dispose();

    private static ConditionFloat NestedCondition() => new()
    {
        CompareOperator = CompareOperator.EqualTo,
        ComparisonValue = 1f,
        Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
    };

    [Theory]
    [InlineData(Cobj, "Conditions", "0.CompareOperator", "\"LessThan\"", """Conditions[0].CompareOperator: "GreaterThan" -> "LessThan" """)]
    [InlineData(Cobj, "Conditions", "0.Data.Unknown3", "7", "Conditions[0].Data.Unknown3: <absent> -> 7")]
    [InlineData(Cobj, "Conditions", "0.Flags", """["OR", "ParametersUseAliases"]""", """Conditions[0].Flags[1]: <absent> -> "ParametersUseAliases" """)]
    [InlineData(Perk, "Effects", "0.Conditions.0.Conditions.0.Data.Function", "\"GetIsSex\"", """Effects[0].Conditions[0].Conditions[0].Data.Function: "GetIsID" -> "GetIsSex" """)]
    [InlineData(Message, "MenuButtons", "0.Conditions.0.Data.RunOnType", "\"Target\"", """MenuButtons[0].Conditions[0].Data.RunOnType: <absent> -> "Target" """)]
    public void ResendingAFieldWithOneConditionMemberChanged_ChangesThatMemberAndNothingElse(
        string record, string member, string path, string replacement, string change)
    {
        var changes = _fixture.Changed(record, _fixture.Resend(record, member, path, replacement));

        Assert.Equal([change.TrimEnd()], changes);
    }

    [Fact]
    public void ArrayAdd_AppendsOneDefaultConditionWithADefaultFunctionData()
    {
        var (result, after) = _fixture.Apply(Cobj, AddAt(Member("Conditions")));

        Assert.True(result.Applied, result.Message);
        var appended = JsonNode.Parse(after.Require()).Require()["Conditions"].Require().AsArray()[2].Require();
        Assert.Equal(
            nameof(FunctionConditionData),
            appended["Data"].Require()["MutagenObjectType"].Require().GetValue<string>());
    }
}
