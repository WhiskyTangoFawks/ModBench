using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>Mutagen aliases <c>ParameterOneNumber</c> and <c>ParameterOneRecord</c> onto the same four
/// bytes, so an unfiltered walk would file a quest stage index as a reference.</summary>
public class ConditionReferenceTests
{
    private static List<string> ConditionRefPaths(PluginFixtureData fixture, FormKey source, FormKey target)
    {
        using var index = Indexes.Reconciled(fixture);
        return [.. index.RequireReads().GetReferencedBy(target.ToString())
            .Where(r => r.FormKey == source.ToString())
            .Select(r => r.FieldPath)
            .Order(StringComparer.Ordinal)];
    }

    [Fact]
    public void AFormParameterIsAReference_AndANumberParameterSharingItsBytesIsNot()
    {
        FormKey cobj = default, quest = default;
        using var fixture = new PluginFixtureBuilder("cond-refs-parameters")
            .WithPlugin("CondRefs.esp", mod =>
            {
                var q = mod.Quests.AddNew("RefQuest");
                quest = q.FormKey;
                var data = new FunctionConditionData
                {
                    Function = Condition.Function.GetStageDone,
                    // A stage index that is also this plugin's own first FormID — an unfiltered walk
                    // would file it as a reference to the quest above.
                    ParameterTwoNumber = (int)q.FormKey.ID,
                };
                data.ParameterOneRecord.SetTo(q.FormKey);
                var recipe = mod.ConstructibleObjects.AddNew("RefRecipe");
                cobj = recipe.FormKey;
                recipe.Conditions.Add(new ConditionFloat { ComparisonValue = 1f, Data = data });
            })
            .Build();

        Assert.Equal(
            ["Conditions[0].Data.ParameterOneRecord"],
            ConditionRefPaths(fixture, cobj, quest));
    }

    [Fact]
    public void AnIdleMemberIsNotFlaggedAsABrokenLink()
    {
        FormKey cobj = default;
        using var fixture = new PluginFixtureBuilder("cond-refs-checkerror")
            .WithPlugin("CondCheck.esp", mod =>
            {
                var data = new FunctionConditionData
                {
                    Function = Condition.Function.IsSneaking,   // uses no parameter slot at all
                    RunOnType = Condition.RunOnType.Subject,    // so Reference is idle and unset
                };
                var recipe = mod.ConstructibleObjects.AddNew("CheckRecipe");
                cobj = recipe.FormKey;
                recipe.Conditions.Add(new ConditionFloat { ComparisonValue = 1f, Data = data });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var document = index.RequireReads().DocumentOf(cobj.ToString(), new PluginCopyKey("CondCheck.esp", "Data"));
        var conditions = document.Fields.Single(f => f.Metadata.Name == "Conditions");

        Assert.Null(conditions.CheckError);
    }

    [Theory]
    [InlineData(Condition.RunOnType.Reference, "Conditions[0].Data.Reference")]
    [InlineData(Condition.RunOnType.Subject, null)]
    public void TheRunOnReferenceIsAReferenceOnlyUnderTheReferenceRunOn(
        Condition.RunOnType runOn, string? expected)
    {
        FormKey cobj = default, quest = default;
        using var fixture = new PluginFixtureBuilder($"cond-refs-runon-{runOn}")
            .WithPlugin("CondRunOn.esp", mod =>
            {
                var q = mod.Quests.AddNew("RunOnQuest");
                quest = q.FormKey;
                // IsSneaking uses no parameter slot at all, so the only link in play is the Run On
                // target — which the record carries whatever the Run On value says.
                var data = new FunctionConditionData { Function = Condition.Function.IsSneaking, RunOnType = runOn };
                data.Reference.SetTo(q.FormKey);
                var recipe = mod.ConstructibleObjects.AddNew("RunOnRecipe");
                cobj = recipe.FormKey;
                recipe.Conditions.Add(new ConditionFloat { ComparisonValue = 1f, Data = data });
            })
            .Build();

        Assert.Equal(
            expected == null ? [] : new[] { expected },
            ConditionRefPaths(fixture, cobj, quest));
    }
}
