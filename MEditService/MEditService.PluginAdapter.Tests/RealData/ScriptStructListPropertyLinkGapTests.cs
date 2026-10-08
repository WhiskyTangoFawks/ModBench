using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter.Tests.RealData;

public sealed class ScriptStructListPropertyLinkGapTests
{
    private static IScriptStructListPropertyGetter LoadRoutesProperty()
    {
        using var scratch = new ScratchDirectory("medit-structlist-");
        var plugin = StructListLinkPlugin.Plugin;
        plugin.WriteInto(scratch);
        var modPath = new ModPath(ModKey.FromFileName(plugin.FileName), Path.Combine(scratch, plugin.FileName));
        var mod = ModFactory.ImportSetter(modPath, GameRelease.Fallout4, FixtureReadParameters.For(new PluginStrings(null, scratch)));

        var quest = mod.EnumerateMajorRecords().OfType<IQuestGetter>()
            .Single(q => q.EditorID == StructListLinkPlugin.QuestEditorId);

        var adapter = quest.VirtualMachineAdapter
            ?? throw new InvalidOperationException($"Expected {StructListLinkPlugin.QuestEditorId} to carry a VirtualMachineAdapter.");
        var script = adapter.Scripts.Single(s => s.Name == StructListLinkPlugin.ScriptName);
        var property = script.Properties.Single(p => p.Name == StructListLinkPlugin.PropertyName);
        return Assert.IsAssignableFrom<IScriptStructListPropertyGetter>(property);
    }

    [Fact]
    public void StructListProperty_OfAGeneratedPlugin_HoldsRealFormLinksThatMutagen688KeepsEnumerateFormLinksFromYielding()
    {
        var structList = LoadRoutesProperty();

        Assert.NotEmpty(structList.Structs);

        var masterFormKey = new FormKey(ModKey.FromFileName(StructListLinkPlugin.Master), StructListLinkPlugin.LinkedMasterFormId);
        var memberFormLinks = structList.Structs
            .SelectMany(s => s.Members)
            .OfType<IScriptObjectPropertyGetter>()
            .Select(p => p.Object.FormKey)
            .ToList();
        Assert.Contains(masterFormKey, memberFormLinks);

        Assert.Empty(structList.EnumerateFormLinks());
    }
}
