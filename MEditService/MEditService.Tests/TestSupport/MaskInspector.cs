using System.Reflection;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// Walks a Mutagen-generated <c>Mask&lt;bool&gt;</c> object graph (Loqui's
/// <c>MaskItem&lt;Overall, Specific&gt;</c> wrappers, indexed collections, and plain bool leaves —
/// the shape <c>IWeaponGetter.GetEqualsMask</c> and its siblings on other record types return) and
/// returns every leaf as a (dotted field path, value) pair. Test-only — production code never
/// needs this; Mutagen generates the mask, this just makes a fidelity-check failure legible
/// ("EditorID" diverged) instead of a bare "objects differ", and makes a walker that silently
/// visited nothing distinguishable from one that found genuine equality (assert on the leaf count,
/// not just on the divergent subset being empty).
/// </summary>
public static class MaskInspector
{
    public static IEnumerable<(string Path, bool Value)> CountLeaves(object? node, string path = "")
    {
        switch (node)
        {
            case null:
                yield break;
            case bool b:
                yield return (path, b);
                yield break;
        }

        var type = node.GetType();

        if (type.GetField("Overall") is { } overallField && type.GetField("Specific") is { } specificField)
        {
            foreach (var leaf in CountLeaves(overallField.GetValue(node), path))
            {
                yield return leaf;
            }

            foreach (var leaf in CountLeaves(specificField.GetValue(node), path))
            {
                yield return leaf;
            }

            yield break;
        }

        if (node is System.Collections.IEnumerable enumerable and not string)
        {
            var i = 0;
            foreach (var element in enumerable)
            {
                var elementType = element?.GetType();
                if (elementType is { IsGenericType: true } && elementType.GetGenericTypeDefinition() == typeof(ValueTuple<,>))
                {
                    var idx = elementType.GetField("Item1")!.GetValue(element);
                    var val = elementType.GetField("Item2")!.GetValue(element);
                    foreach (var leaf in CountLeaves(val, $"{path}[{idx}]"))
                    {
                        yield return leaf;
                    }
                }
                else
                {
                    foreach (var leaf in CountLeaves(element, $"{path}[{i}]"))
                    {
                        yield return leaf;
                    }
                }

                i++;
            }

            yield break;
        }

        foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            var childPath = path.Length == 0 ? field.Name : $"{path}.{field.Name}";
            foreach (var leaf in CountLeaves(field.GetValue(node), childPath))
            {
                yield return leaf;
            }
        }

        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (prop.GetIndexParameters().Length > 0)
            {
                continue;
            }

            var childPath = path.Length == 0 ? prop.Name : $"{path}.{prop.Name}";
            foreach (var leaf in CountLeaves(prop.GetValue(node), childPath))
            {
                yield return leaf;
            }
        }
    }
}
