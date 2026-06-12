using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

public sealed class ReferencePluginFixture : IDisposable
{
    public string DataFolder => _data.DataFolder;
    public string PluginsTxtPath => _data.PluginsTxtPath;
    public const string PluginName = "RefPlugin.esp";

    /// <summary>Keyword FormKey — used as the reference target in all reference tests.</summary>
    public FormKey KeywordFormKey { get; }

    /// <summary>NPC that has KeywordFormKey in its Keywords list (committed reference).</summary>
    public FormKey NpcWithKeywordFormKey { get; }

    /// <summary>NPC with no keywords (used for pending-addition test).</summary>
    public FormKey NpcWithoutKeywordFormKey { get; }

    private readonly PluginFixtureData _data;

    public ReferencePluginFixture()
    {
        FormKey kw = default;
        FormKey npcWith = default;
        FormKey npcWithout = default;

        _data = new PluginFixtureBuilder("medit-refs")
            .WithPlugin(PluginName, mod =>
            {
                var keyword = mod.Keywords.AddNew();
                keyword.EditorID = "TestKeyword01";
                kw = keyword.FormKey;

                var n1 = mod.Npcs.AddNew("TestNPC_WithKw");
                n1.Keywords = [new FormLink<IKeywordGetter>(kw)];
                npcWith = n1.FormKey;

                var n2 = mod.Npcs.AddNew("TestNPC_NoKw");
                npcWithout = n2.FormKey;
            })
            .Build();

        KeywordFormKey = kw;
        NpcWithKeywordFormKey = npcWith;
        NpcWithoutKeywordFormKey = npcWithout;
    }

    public void Dispose() => _data.Dispose();
}
