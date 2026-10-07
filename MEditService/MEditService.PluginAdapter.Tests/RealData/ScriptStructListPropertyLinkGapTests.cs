using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter.Tests.RealData;

public sealed class ScriptStructListPropertyLinkGapTests
{
    private static readonly string FixturePath =
        Path.Combine(AppContext.BaseDirectory, "TestData", "SpaDia_AMR.esp");

    private static IScriptStructListPropertyGetter LoadLeveledListDataProperty()
    {
        var modKey = ModKey.FromFileName("SpaDia_AMR.esp");
        var modPath = new ModPath(modKey, FixturePath);
        var mod = ModFactory.ImportSetter(modPath, GameRelease.Fallout4, FixtureReadParameters.For(new PluginStrings(null, Path.GetDirectoryName(FixturePath) ?? throw new InvalidOperationException($"Expected '{FixturePath}' to have a parent directory."))));

        var quest = mod.EnumerateMajorRecords().OfType<IQuestGetter>()
            .Single(q => q.EditorID == "DiaQ_LLInjector_SpadeyAMR");

        var adapter = quest.VirtualMachineAdapter
            ?? throw new InvalidOperationException("Expected DiaQ_LLInjector_SpadeyAMR to carry a VirtualMachineAdapter.");
        var script = adapter.Scripts.Single(s => s.Name == "DLC04:DLCLegendaryLLManagerScript");
        var property = script.Properties.Single(p => p.Name == "LeveledListData");
        return Assert.IsAssignableFrom<IScriptStructListPropertyGetter>(property);
    }

    [Fact]
    public void StructListProperty_OfTheRealSpaDiaAMRFixture_HoldsRealFormLinksThatMutagen688KeepsEnumerateFormLinksFromYielding()
    {
        var structList = LoadLeveledListDataProperty();

        Assert.NotEmpty(structList.Structs);

        var nukaWorldFormKey = FormKey.Factory("03F98D:DLCNukaWorld.esm");
        var memberFormLinks = structList.Structs
            .SelectMany(s => s.Members)
            .OfType<IScriptObjectPropertyGetter>()
            .Select(p => p.Object.FormKey)
            .ToList();
        Assert.Contains(nukaWorldFormKey, memberFormLinks);

        Assert.Empty(structList.EnumerateFormLinks());
    }
}
