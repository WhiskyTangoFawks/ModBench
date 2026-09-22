using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>Three plugins disagreeing over several records, loaded through the real host — the
/// hardest classifications to get wrong, so the compare wire response reaches every shape at
/// once.</summary>
public sealed class CompareGoldenApiFixture : IDisposable
{
    public PluginFixtureData Fixture { get; }
    public MEditHost App { get; } = new();
    public HttpClient Client { get; }

    public static readonly FormKey ConflictedNpc = MakeKey("Base.esm", 0x800);
    public static readonly FormKey UnchangedWeapon = MakeKey("Base.esm", 0x801);
    public static readonly FormKey SoleNpc = MakeKey("Base.esm", 0x802);
    public static readonly FormKey InjectedNpc = MakeKey("Mid.esp", 0x800);
    public static readonly FormKey ConflictedRecipe = MakeKey("Base.esm", 0x803);

    private static FormKey MakeKey(string plugin, uint id) => new(ModKey.FromFileName(plugin), id);

    public CompareGoldenApiFixture()
    {
        Fixture = new PluginFixtureBuilder("compare-golden")
            .WithPlugin("Base.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("ConflictedNPC");
                npc.Name = "Base name";
                npc.CalculatedHealth = 100;
                npc.Race.SetTo(MakeKey("Base.esm", 0x900));

                var weapon = mod.Weapons.AddNew("UnchangedWeapon");
                weapon.Value = 25;
                weapon.Weight = 2.5f;

                var lonely = mod.Npcs.AddNew("SoleNPC");
                lonely.CalculatedHealth = 7;

                // A condition list is an ordinary reflected array column, so a record carrying one belongs in this
                // golden like any other conflicting field: the classifier producing its diff tree is the one
                // classifier, with no section of its own.
                var recipe = mod.ConstructibleObjects.AddNew("ConflictedRecipe");
                recipe.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Flags = Condition.Flag.OR,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
            })
            .WithPlugin("Mid.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                // A real override that changes two fields and leaves the rest alone.
                var npc = basePlugin.Npcs.First(n => n.FormKey == ConflictedNpc).DeepCopy();
                npc.Name = "Mid name";
                npc.CalculatedHealth = 250;
                mod.Npcs.Set(npc);

                // An override identical to its master — the ITM shape, which must classify as
                // no conflict rather than as a difference of zero size.
                mod.Weapons.Set(basePlugin.Weapons.First(w => w.FormKey == UnchangedWeapon).DeepCopy());

                // A record injected into a master's FormID space by a plugin that isn't its origin.
                mod.Npcs.AddNew("InjectedNPC").Name = "Injected";
            })
            .WithPlugin("Top.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                // The winning override: disagrees with both of the copies below it.
                var npc = basePlugin.Npcs.First(n => n.FormKey == ConflictedNpc).DeepCopy();
                npc.Name = "Top name";
                npc.CalculatedHealth = 999;
                npc.Race.SetTo(MakeKey("Base.esm", 0x901));
                mod.Npcs.Set(npc);

                // The condition list disagrees with its master on one member of one condition —
                // the compare tree has to reach the member, not stop at the array.
                var recipe = basePlugin.ConstructibleObjects.First(c => c.FormKey == ConflictedRecipe).DeepCopy();
                recipe.Conditions[0].Data.RunOnType = Condition.RunOnType.Target;
                mod.ConstructibleObjects.Set(recipe);
            })
            .Build();

        Client = App.CreateClient();
        var response = Client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = Fixture.DataFolder,
            instanceRoot = Fixture.InstanceRoot,
            plugins = Fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        }).GetAwaiter().GetResult();
        response.EnsureSuccessStatusCode();
    }

    public void Dispose()
    {
        Client.Dispose();
        App.Dispose();
        Fixture.Dispose();
    }
}
