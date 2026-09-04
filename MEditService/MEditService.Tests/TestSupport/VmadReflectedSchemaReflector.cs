using MEditService.Core.Schema;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// A Fallout 4 reflector with the shipped VMAD exclusion lifted, so the adapter and its script
/// properties are reflected as ordinary columns — the only way a test reaches the concrete-base
/// union that matters (#701). Never what ships.
/// </summary>
internal static class VmadReflectedSchemaReflector
{
    public static SchemaReflector Instance { get; } = Fallout4With(WithVmadReflected);

    /// <summary>A reflector over the shipped tables with one amendment, through the annotation seam.</summary>
    public static SchemaReflector Fallout4With(Func<SchemaAnnotations, SchemaAnnotations> amend) =>
        new(category => amend(SchemaAnnotations.For(category)));

    public static SchemaAnnotations WithVmadReflected(SchemaAnnotations a) =>
        a with { ExcludedUnions = [.. a.ExcludedUnions.Where(u => u != "AVirtualMachineAdapter")] };
}
