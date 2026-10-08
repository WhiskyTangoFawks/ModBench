using System.Reflection;

namespace MEditService.Codec.Tests.TestSupport;

/// <summary>Flattens a Mutagen <c>Mask&lt;bool&gt;</c> graph to (dotted path, value) leaves, so a
/// fidelity failure names the field and a walker that visited nothing is distinguishable from
/// genuine equality (assert on the leaf count).</summary>
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
                    var item1Field = elementType.GetField("Item1")
                        ?? throw new InvalidOperationException($"Expected '{elementType.Name}' to declare Item1.");
                    var item2Field = elementType.GetField("Item2")
                        ?? throw new InvalidOperationException($"Expected '{elementType.Name}' to declare Item2.");
                    var idx = item1Field.GetValue(element);
                    var val = item2Field.GetValue(element);
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
