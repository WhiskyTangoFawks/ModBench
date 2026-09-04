using MEditService.Core.Plugins;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

public sealed class ReferencePluginFixture : IApiPluginFixture<ReferencePluginFixture>
{
    public string DataFolder => _data.DataFolder;
    public IReadOnlyList<LoadOrderEntry> Plugins => _data.Plugins;
    public string InstanceRoot => _data.InstanceRoot;
    public const string PluginName = "RefPlugin.esp";

    public FormKey KeywordFormKey { get; }

    public FormKey NpcWithKeywordFormKey { get; }

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

    public static ReferencePluginFixture Create() => new();
}
