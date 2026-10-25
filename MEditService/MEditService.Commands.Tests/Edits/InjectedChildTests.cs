using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class InjectedChildTests : TestInstance
{
    public static TheoryData<Func<InjectedChildTests, FormKey>, Func<InjectedChildTests, FormKey>> Injections => new()
    {
        { t => t._quest, t => t._injectedTopic },
        { t => t._quest, t => t._injectedBranch },
        { t => t._quest, t => t._injectedScene },
        { t => t._baseTopic, t => t._injectedResponse },
    };

    private readonly PluginAddress _base;
    private readonly PluginAddress _injector;

    private readonly FormKey _quest;
    private readonly FormKey _baseTopic;
    private readonly FormKey _injectedTopic;
    private readonly FormKey _injectedBranch;
    private readonly FormKey _injectedScene;
    private readonly FormKey _injectedResponse;

    public InjectedChildTests()
    {
        var baseMod = new Fallout4Mod(ModKey.FromFileName("InjectionBase.esm"), Fallout4Release.Fallout4);
        var baseQuest = new Quest(baseMod) { EditorID = "BaseQuest" };
        var baseTopic = new DialogTopic(baseMod) { EditorID = "BaseTopic" };
        baseTopic.Responses.Add(new DialogResponses(baseMod) { EditorID = "BaseResponse" });
        baseQuest.DialogTopics.Add(baseTopic);
        baseQuest.DialogBranches.Add(new DialogBranch(baseMod) { EditorID = "BaseBranch" });
        baseQuest.Scenes.Add(new Scene(baseMod) { EditorID = "BaseScene" });
        baseMod.Quests.Add(baseQuest);
        (_quest, _baseTopic) = (baseQuest.FormKey, baseTopic.FormKey);
        _base = Add(baseMod, "InjectionBaseMod");

        var injectorMod = new Fallout4Mod(ModKey.FromFileName("InjectionInjector.esp"), Fallout4Release.Fallout4);
        injectorMod.ModHeader.MasterReferences.Add(new MasterReference { Master = baseMod.ModKey });
        var questOverride = new Quest(_quest, Fallout4Release.Fallout4) { EditorID = "BaseQuest" };
        var topicOverride = new DialogTopic(_baseTopic, Fallout4Release.Fallout4) { EditorID = "BaseTopic" };
        var injectedResponse = new DialogResponses(injectorMod) { EditorID = "InjectedResponse" };
        var injectedTopic = new DialogTopic(injectorMod) { EditorID = "InjectedTopic" };
        var injectedBranch = new DialogBranch(injectorMod) { EditorID = "InjectedBranch" };
        var injectedScene = new Scene(injectorMod) { EditorID = "InjectedScene" };
        topicOverride.Responses.Add(injectedResponse);
        questOverride.DialogTopics.Add(topicOverride);
        questOverride.DialogTopics.Add(injectedTopic);
        questOverride.DialogBranches.Add(injectedBranch);
        questOverride.Scenes.Add(injectedScene);
        injectorMod.Quests.Add(questOverride);
        (_injectedTopic, _injectedBranch, _injectedScene, _injectedResponse) =
            (injectedTopic.FormKey, injectedBranch.FormKey, injectedScene.FormKey, injectedResponse.FormKey);
        _injector = Add(injectorMod, "InjectionInjectorMod");
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public async Task AfterInitAndCompileOfBothPlugins_TheInjectingPluginsBinaryHoldsTheChildUnderItsContainer(
        Func<InjectedChildTests, FormKey> container, Func<InjectedChildTests, FormKey> child)
    {
        using var compiled = await this.CompiledAsync(_injector);

        Assert.Contains(child(this), ChildrenOf(compiled, container(this)));
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public async Task AfterInitAndCompileOfBothPlugins_TheOwningPluginsBinaryKeepsItsOwnChildrenAndNotTheInjected(
        Func<InjectedChildTests, FormKey> container, Func<InjectedChildTests, FormKey> child)
    {
        using var compiled = await this.CompiledAsync(_base);

        var own = ChildrenOf(compiled, container(this));
        Assert.DoesNotContain(child(this), own);
        Assert.NotEmpty(own);
    }

    private static IEnumerable<FormKey> ChildrenOf(IModGetter mod, FormKey container) =>
        mod.EnumerateMajorRecords().Single(r => r.FormKey == container)
            .EnumerateMajorRecords().Select(r => r.FormKey);
}
