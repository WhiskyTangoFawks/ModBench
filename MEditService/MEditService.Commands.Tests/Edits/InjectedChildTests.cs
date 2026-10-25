using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class InjectedChildTests : TestInstance
{
    public static TheoryData<string> Injections => ["topic", "branch", "scene", "response"];

    private readonly PluginAddress _base;
    private readonly PluginAddress _injector;
    private readonly Dictionary<string, (FormKey Container, FormKey Child)> _injections;

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
        _base = Add(baseMod, "InjectionBaseMod");

        var injectorMod = new Fallout4Mod(ModKey.FromFileName("InjectionInjector.esp"), Fallout4Release.Fallout4);
        injectorMod.ModHeader.MasterReferences.Add(new MasterReference { Master = baseMod.ModKey });
        var questOverride = new Quest(baseQuest.FormKey, Fallout4Release.Fallout4) { EditorID = "BaseQuest" };
        var topicOverride = new DialogTopic(baseTopic.FormKey, Fallout4Release.Fallout4) { EditorID = "BaseTopic" };
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
        _injections = new()
        {
            ["topic"] = (baseQuest.FormKey, injectedTopic.FormKey),
            ["branch"] = (baseQuest.FormKey, injectedBranch.FormKey),
            ["scene"] = (baseQuest.FormKey, injectedScene.FormKey),
            ["response"] = (baseTopic.FormKey, injectedResponse.FormKey),
        };
        _injector = Add(injectorMod, "InjectionInjectorMod");
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public async Task AfterInitAndCompileOfBothPlugins_TheInjectingPluginsBinaryHoldsTheChildUnderItsContainer(string injected)
    {
        var (container, child) = _injections[injected];
        using var compiled = await this.CompiledAsync(_injector);

        Assert.Contains(child, ChildrenOf(compiled, container));
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public async Task AfterInitAndCompileOfBothPlugins_TheOwningPluginsBinaryKeepsItsOwnChildrenAndNotTheInjected(string injected)
    {
        var (container, child) = _injections[injected];
        using var compiled = await this.CompiledAsync(_base);

        var own = ChildrenOf(compiled, container);
        Assert.DoesNotContain(child, own);
        Assert.NotEmpty(own);
    }

    private static IEnumerable<FormKey> ChildrenOf(IModGetter mod, FormKey container) =>
        mod.EnumerateMajorRecords().Single(r => r.FormKey == container)
            .EnumerateMajorRecords().Select(r => r.FormKey);
}
