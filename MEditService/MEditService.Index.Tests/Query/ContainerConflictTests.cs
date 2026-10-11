using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class ContainerConflictTests
{
    private static readonly FormKey Container = ComparedCopies.InMaster(0x800);
    private static readonly FormKey Child = ComparedCopies.InMaster(0x801);

    public enum Held { PlacedReference, Navmesh }

    private static void AddContainerHoldingChildNamed(Fallout4Mod mod, Held held, string childEditorId)
    {
        switch (held)
        {
            case Held.PlacedReference:
                var room = new Cell(Container, Fallout4Release.Fallout4) { EditorID = "Room" };
                room.Temporary.Add(new PlacedObject(Child, Fallout4Release.Fallout4) { EditorID = childEditorId });
                mod.AddInteriorCells(room);
                break;
            case Held.Navmesh:
                var navigated = new Cell(Container, Fallout4Release.Fallout4) { EditorID = "Room" };
                navigated.NavigationMeshes.Add(new NavigationMesh(Child, Fallout4Release.Fallout4) { EditorID = childEditorId });
                mod.AddInteriorCells(navigated);
                break;
        }
    }

    private static (ConflictThis? Container, ConflictThis? Child) OverridersConflicts(Held held)
    {
        using var fixture = new PluginFixtureBuilder("container-conflict")
            .WithPlugin("A.esp", mod => AddContainerHoldingChildNamed(mod, held, "HeldByA"))
            .WithPlugin("B.esp", mod => AddContainerHoldingChildNamed(mod, held, "HeldByB"))
            .Build();
        using var index = Indexes.Reconciled(fixture);

        return (Overriders(Container), Overriders(Child));

        ConflictThis? Overriders(FormKey formKey) =>
            (index.Queries.GetCompare(formKey.ToString()).Value()
                ?? throw new InvalidOperationException($"Expected {formKey} to compare.")).Overrides.Single(o => o.Plugin == "B.esp").ConflictThis;
    }

    [Theory]
    [InlineData(Held.PlacedReference)]
    [InlineData(Held.Navmesh)]
    public void TwoCopiesOfAContainer_DifferingOnlyInsideAChild_AreIdentical_AndTheChildShowsTheDifference(Held held)
    {
        Assert.Equal((ConflictThis.IdenticalToMaster, ConflictThis.Override), OverridersConflicts(held));
    }
}
