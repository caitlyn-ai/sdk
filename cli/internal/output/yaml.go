package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

// writeYAML converts JSON to YAML, keeping member order (so a draft exported to YAML reads as the server wrote it).
func writeYAML(w io.Writer, raw []byte) error {
	n, err := JSONToYAMLNode(raw)
	if err != nil {
		return err
	}
	enc := yaml.NewEncoder(w)
	enc.SetIndent(2)
	if err := enc.Encode(n); err != nil {
		return err
	}
	return enc.Close()
}

// JSONToYAML converts JSON to YAML text as -o yaml writes it: member order kept, two-space indents.
func JSONToYAML(raw []byte) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeYAML(&buf, raw); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// JSONToYAMLNode reads JSON into a YAML node tree in document order.
func JSONToYAMLNode(raw []byte) (*yaml.Node, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	n, err := readNode(dec)
	if err != nil {
		return nil, fmt.Errorf("the response is not JSON: %w", err)
	}
	return n, nil
}

func readNode(dec *json.Decoder) (*yaml.Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			n := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: fmt.Sprint(kt)}
				v, err := readNode(dec)
				if err != nil {
					return nil, err
				}
				n.Content = append(n.Content, k, v)
			}
			_, err := dec.Token()
			return n, err
		case '[':
			n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for dec.More() {
				v, err := readNode(dec)
				if err != nil {
					return nil, err
				}
				n.Content = append(n.Content, v)
			}
			_, err := dec.Token()
			return n, err
		}
	case string:
		n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: t}
		if len(t) > 80 || bytes.ContainsRune([]byte(t), '\n') {
			n.Style = yaml.LiteralStyle
			if !bytes.ContainsRune([]byte(t), '\n') {
				n.Style = 0
			}
		}
		return n, nil
	case json.Number:
		tag := "!!int"
		if bytes.ContainsAny([]byte(t), ".eE") {
			tag = "!!float"
		}
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: t.String()}, nil
	case bool:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: fmt.Sprint(t)}, nil
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}, nil
	}
	return nil, fmt.Errorf("unexpected JSON token %v", tok)
}

// YAMLToJSON reads a YAML (or JSON) document as JSON, keeping member order: --from-file and draft files.
func YAMLToJSON(b []byte) ([]byte, error) {
	var n yaml.Node
	if err := yaml.Unmarshal(b, &n); err != nil {
		return nil, err
	}
	if n.Kind == 0 {
		return []byte("null"), nil
	}
	var buf bytes.Buffer
	if err := writeJSONNode(&buf, &n); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeJSONNode(buf *bytes.Buffer, n *yaml.Node) error {
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			buf.WriteString("null")
			return nil
		}
		return writeJSONNode(buf, n.Content[0])
	case yaml.AliasNode:
		return writeJSONNode(buf, n.Alias)
	case yaml.MappingNode:
		buf.WriteByte('{')
		for i := 0; i+1 < len(n.Content); i += 2 {
			if i > 0 {
				buf.WriteByte(',')
			}
			k, _ := json.Marshal(n.Content[i].Value)
			buf.Write(k)
			buf.WriteByte(':')
			if err := writeJSONNode(buf, n.Content[i+1]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case yaml.SequenceNode:
		buf.WriteByte('[')
		for i, c := range n.Content {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeJSONNode(buf, c); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case yaml.ScalarNode:
		var v any
		if err := n.Decode(&v); err != nil {
			return err
		}
		switch n.Tag {
		case "!!str", "!!binary", "!!timestamp":
			v = n.Value
		}
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		buf.Write(b)
	}
	return nil
}
